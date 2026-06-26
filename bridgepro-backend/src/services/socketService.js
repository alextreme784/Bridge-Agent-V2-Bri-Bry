const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const { createClient } = require('redis');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { notifyNewMessage } = require('./pushService');

let io = null;

function init(httpServer) {
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : [
        'https://bridgepro.a3tech.uk',
        'https://api.bridgepro.a3tech.uk',
        'https://connek.a3tech.uk',
        'http://localhost:3000',
        'http://localhost:5173'
      ];

  io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error('Not allowed by CORS'));
        }
      },
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  const pubClient = createClient({ url: process.env.REDIS_URL || 'redis://127.0.0.1:6379' });
  const subClient = pubClient.duplicate();
  Promise.all([pubClient.connect(), subClient.connect()])
    .then(() => {
      io.adapter(createAdapter(pubClient, subClient));
      console.log('[socket.io] Redis adapter connected');
    })
    .catch((err) => {
      console.warn('[socket.io] Redis adapter failed, falling back to in-memory:', err.message);
    });

  // Auth middleware — expects token in socket.handshake.auth.token
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication required'));
    try {
      socket.user = jwt.verify(token, process.env.JWT_SECRET);
      next();
    } catch {
      next(new Error('Invalid or expired token'));
    }
  });

  io.on('connection', async (socket) => {
    const userId = socket.user.id;
    socket.data = socket.data || {};
    socket.data.user_id = userId;

    // Single-session enforcement (disconnect any other tabs/devices for this user)
    try {
      const sockets = await io.fetchSockets();
      for (const s of sockets) {
        if (s.id !== socket.id && s.data && s.data.user_id === userId) {
          s.emit('force_logout', { message: 'You have logged in from another device or tab.' });
          s.disconnect(true);
        }
      }
    } catch (err) {
      console.error('[socket] single-session enforcement error:', err.message);
    }

    // Each user joins their own room so REST endpoints can target them directly
    socket.join('user_' + userId);

    // Join a conversation room
    socket.on('join_conversation', (conversation_id) => {
      socket.join(String(conversation_id));
    });

    // Send a message
    socket.on('send_message', async ({ conversation_id, body, message_type, file_url }) => {
      try {
        if (!conversation_id) return;
        if (!body && !file_url) return;

        const conv = await db.query(
          'SELECT customer_id, provider_id, status FROM bc_conversations WHERE id = $1',
          [conversation_id]
        );
        if (!conv.rows.length) return;

        const c = conv.rows[0];
        if (c.customer_id !== userId && c.provider_id !== userId) return;
        if (c.status === 'closed') {
          socket.emit('error', { message: 'Conversation is closed' });
          return;
        }

        const result = await db.query(
          `INSERT INTO bc_messages (conversation_id, sender_id, body, message_type, file_url)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [conversation_id, userId, body?.trim() || null, message_type || 'text', file_url || null]
        );

        const saved = result.rows[0];

        const userRow = await db.query('SELECT full_name FROM users WHERE id = $1', [userId]);
        const senderName = userRow.rows[0]?.full_name || 'Someone';
        saved.sender_name = senderName;

        io.to(String(conversation_id)).emit('receive_message', saved);

        const recipientId = c.customer_id === userId ? c.provider_id : c.customer_id;
        notifyNewMessage(recipientId, senderName, conversation_id).catch(() => {});
      } catch (err) {
        console.error('[socket] send_message error:', err.message);
      }
    });

    // Socket client triggers initiate_chat from push reminder
    socket.on('initiate_chat', async ({ providerId }, callback) => {
      try {
        if (!providerId) {
          return callback && callback({ error: 'providerId is required' });
        }
        const listingRes = await db.query(
          'SELECT id, user_id FROM listings WHERE user_id = $1 OR id = $1', 
          [providerId]
        );
        if (!listingRes.rows.length) {
          return callback && callback({ error: 'Provider or listing not found' });
        }
        const listing = listingRes.rows[0];
        if (listing.user_id === userId) {
          return callback && callback({ error: 'You cannot chat with yourself' });
        }

        let conversation_id;
        const existing = await db.query(
          'SELECT id FROM bc_conversations WHERE listing_id = $1 AND customer_id = $2',
          [listing.id, userId]
        );
        if (existing.rows.length) {
          conversation_id = existing.rows[0].id;
        } else {
          const convRes = await db.query(
            `INSERT INTO bc_conversations (listing_id, customer_id, provider_id)
             VALUES ($1, $2, $3) RETURNING id`,
            [listing.id, userId, listing.user_id]
          );
          conversation_id = convRes.rows[0].id;
        }

        if (callback) {
          callback({ conversation_id });
        } else {
          socket.emit('chat_initiated', { conversation_id });
        }
      } catch (err) {
        console.error('[Socket] initiate_chat crash:', err.message);
        if (callback) callback({ error: err.message });
      }
    });

    // Typing indicator — broadcast to everyone in the room except the sender
    socket.on('typing', ({ conversation_id, is_typing }) => {
      if (!conversation_id) return;
      socket.to(String(conversation_id)).emit('typing', {
        user_id: userId,
        is_typing: Boolean(is_typing),
      });
    });

    // Notify the room that the conversation has been closed
    socket.on('conversation_closed', (conversation_id) => {
      if (!conversation_id) return;
      io.to(String(conversation_id)).emit('conversation_closed', { conversation_id });
    });

    // ── BridgeMeet socket events ─────────────────────────────────────────────

    // Join a BridgeMeet session room (new canonical event)
    socket.on('bridgemeet_join_room', (room_id) => {
      if (room_id) socket.join(room_id);
    });

    // Legacy join event — keep for compat
    socket.on('bridgemeet_join', (sessionId) => {
      if (sessionId) socket.join('bridgemeet_' + sessionId);
    });

    // Send anonymous message — broadcast to room, emit bridgemeet_receive to others
    socket.on('bridgemeet_message', ({ room_id, session_id, body }) => {
      const room = room_id || (session_id ? 'bridgemeet_' + session_id : null);
      if (!room || !body) return;
      socket.to(room).emit('bridgemeet_receive', {
        sender_id: userId,
        body: String(body).slice(0, 500),
        ts: Date.now(),
      });
    });

    // Typing indicator
    socket.on('bridgemeet_typing', ({ room_id, session_id, is_typing }) => {
      const room = room_id || (session_id ? 'bridgemeet_' + session_id : null);
      if (!room) return;
      socket.to(room).emit('bridgemeet_typing', { is_typing: Boolean(is_typing) });
    });

    // Request identity reveal (forwarded to other participant)
    socket.on('bridgemeet_reveal', ({ room_id, session_id }) => {
      const room = room_id || (session_id ? 'bridgemeet_' + session_id : null);
      if (!room) return;
      socket.to(room).emit('bridgemeet_reveal_request', { session_id: session_id || room_id?.replace('bridgemeet_', '') });
    });

    // ── Transport tracking events (Redis-backed for cluster compatibility) ─────────────────────
    socket.on('join_transport', async (country_code) => {
      console.log(`[socket] join_transport: ${country_code} from ${socket.id}`);
      if (country_code) {
        socket.join('transport_' + country_code);
        try {
          await pubClient.set(`transport:socket_country:${socket.id}`, country_code, { EX: 7200 }); // Expire after 2 hours
          
          // Get all active drivers for this country
          const driverIds = await pubClient.sMembers(`transport:drivers_set:${country_code}`);
          const drivers = [];
          for (const dId of driverIds) {
            const data = await pubClient.get(`transport:driver:${dId}`);
            if (data) {
              const d = JSON.parse(data);
              drivers.push({
                id: dId,
                name: d.name,
                plate: d.plate || 'Live Van',
                route_id: d.route_id,
                status: d.status || 'Active',
                lat: d.lat || 0,
                lng: d.lng || 0,
                type: d.type || 'van',
                vehicle_type: d.vehicle_type || null,
                company: d.company || null,
                photo: d.photo || null,
                target_id: d.target_id || null
              });
            } else {
              // Self-healing: key expired, remove from set
              await pubClient.sRem(`transport:drivers_set:${country_code}`, dId);
            }
          }

          // Get all active passengers for this country
          const passengerIds = await pubClient.sMembers(`transport:passengers_set:${country_code}`);
          const passengers = [];
          for (const pId of passengerIds) {
            const data = await pubClient.get(`transport:passenger:${pId}`);
            if (data) {
              const p = JSON.parse(data);
              passengers.push({
                id: pId,
                stopId: p.stopId,
                routeId: p.routeId
              });
            } else {
              // Self-healing: key expired, remove from set
              await pubClient.sRem(`transport:passengers_set:${country_code}`, pId);
            }
          }

          socket.emit('driver_list', drivers);
          socket.emit('passenger_list', passengers);
        } catch (err) {
          console.error('[socket] join_transport Redis error:', err.message);
        }
      }
    });

    socket.on('driver_start', async (data) => {
      console.log(`[socket] driver_start:`, data, `from ${socket.id}`);
      if (!data || !data.country_code) return;
      
      const driverObj = {
        name: data.name || 'Driver',
        plate: data.plate || 'Live Van',
        country_code: data.country_code,
        route_id: data.route_id || null,
        lat: 0,
        lng: 0,
        status: 'Active',
        type: data.type || 'van',
        vehicle_type: data.vehicle_type || null,
        company: data.company || null,
        photo: data.photo || null,
        target_id: data.target_id || null
      };

      // Clean up any old duplicate driver entries with the same name and type to prevent ghost duplicates
      try {
        const driverIds = await pubClient.sMembers(`transport:drivers_set:${data.country_code}`);
        for (const dId of driverIds) {
          if (dId !== socket.id) {
            const oldData = await pubClient.get(`transport:driver:${dId}`);
            if (oldData) {
              const oldD = JSON.parse(oldData);
              if (oldD.name === driverObj.name && oldD.type === driverObj.type) {
                await pubClient.del(`transport:driver:${dId}`);
                await pubClient.sRem(`transport:drivers_set:${data.country_code}`, dId);
                socket.to('transport_' + data.country_code).emit('driver_left', { id: dId });
              }
            }
          }
        }
      } catch (err) {
        console.error('[socket] driver_start duplicate cleanup error:', err.message);
      }

      try {
        await pubClient.set(`transport:driver:${socket.id}`, JSON.stringify(driverObj), { EX: 3600 });
        await pubClient.sAdd(`transport:drivers_set:${data.country_code}`, socket.id);
        
        socket.to('transport_' + data.country_code).emit('driver_list', [{
          id: socket.id,
          name: driverObj.name,
          plate: driverObj.plate,
          route_id: driverObj.route_id,
          status: driverObj.status,
          lat: 0,
          lng: 0,
          type: driverObj.type,
          vehicle_type: driverObj.vehicle_type,
          company: driverObj.company,
          photo: driverObj.photo,
          target_id: driverObj.target_id
        }]);
      } catch (err) {
        console.error('[socket] driver_start Redis error:', err.message);
      }
    });

    socket.on('location_update', async (data) => {
      if (!data) return;
      try {
        const driverData = await pubClient.get(`transport:driver:${socket.id}`);
        if (!driverData) return;
        const d = JSON.parse(driverData);
        d.lat = data.lat;
        d.lng = data.lng;
        d.status = 'Active'; // Reset status to active when location is received
        await pubClient.set(`transport:driver:${socket.id}`, JSON.stringify(d), { EX: 3600 });

        socket.to('transport_' + d.country_code).emit('driver_moved', {
          id: socket.id,
          name: d.name,
          plate: d.plate || 'Live Van',
          route_id: d.route_id,
          lat: data.lat,
          lng: data.lng,
          status: d.status,
          type: d.type || 'van',
          vehicle_type: d.vehicle_type || null,
          company: d.company || null,
          photo: d.photo || null,
          target_id: d.target_id || null
        });
      } catch (err) {
        console.error('[socket] location_update Redis error:', err.message);
      }
    });

    socket.on('driver_stop', async () => {
      console.log(`[socket] driver_stop from ${socket.id}`);
      try {
        const driverData = await pubClient.get(`transport:driver:${socket.id}`);
        if (driverData) {
          const d = JSON.parse(driverData);
          await pubClient.del(`transport:driver:${socket.id}`);
          await pubClient.sRem(`transport:drivers_set:${d.country_code}`, socket.id);
          socket.to('transport_' + d.country_code).emit('driver_left', { id: socket.id });
        }
      } catch (err) {
        console.error('[socket] driver_stop Redis error:', err.message);
      }
    });

    socket.on('passenger_waiting', async (data) => {
      console.log(`[socket] passenger_waiting:`, data, `from ${socket.id}`);
      if (!data) return;
      try {
        const country_code = await pubClient.get(`transport:socket_country:${socket.id}`) || 'VC';
        const passengerObj = {
          stopId: data.stopId,
          routeId: data.routeId,
          country_code
        };
        await pubClient.set(`transport:passenger:${socket.id}`, JSON.stringify(passengerObj), { EX: 3600 });
        await pubClient.sAdd(`transport:passengers_set:${country_code}`, socket.id);

        socket.to('transport_' + country_code).emit('passenger_waiting', {
          id: socket.id,
          stopId: data.stopId,
          routeId: data.routeId
        });
      } catch (err) {
        console.error('[socket] passenger_waiting Redis error:', err.message);
      }
    });

    socket.on('passenger_cancel', async () => {
      console.log(`[socket] passenger_cancel from ${socket.id}`);
      try {
        const passengerData = await pubClient.get(`transport:passenger:${socket.id}`);
        if (passengerData) {
          const p = JSON.parse(passengerData);
          await pubClient.del(`transport:passenger:${socket.id}`);
          await pubClient.sRem(`transport:passengers_set:${p.country_code}`, socket.id);
          socket.to('transport_' + p.country_code).emit('passenger_left', { id: socket.id });
        }
      } catch (err) {
        console.error('[socket] passenger_cancel Redis error:', err.message);
      }
    });

    socket.on('disconnect', async () => {
      try {
        const country_code = await pubClient.get(`transport:socket_country:${socket.id}`);
        if (country_code) {
          await pubClient.del(`transport:socket_country:${socket.id}`);
        }
        
        const driverData = await pubClient.get(`transport:driver:${socket.id}`);
        if (driverData) {
          const d = JSON.parse(driverData);
          // Instead of deleting driver immediately, mark as Sleeping for a 3-minute grace period
          d.status = 'Sleeping';
          d.lastUpdate = Date.now();
          await pubClient.set(`transport:driver:${socket.id}`, JSON.stringify(d), { EX: 180 }); // Expire in 3 mins
          
          socket.to('transport_' + d.country_code).emit('driver_moved', {
            id: socket.id,
            name: d.name,
            plate: d.plate || 'Live Van',
            route_id: d.route_id,
            lat: d.lat,
            lng: d.lng,
            status: 'Sleeping'
          });
        }
        
        const passengerData = await pubClient.get(`transport:passenger:${socket.id}`);
        if (passengerData) {
          const p = JSON.parse(passengerData);
          await pubClient.del(`transport:passenger:${socket.id}`);
          await pubClient.sRem(`transport:passengers_set:${p.country_code}`, socket.id);
          socket.to('transport_' + p.country_code).emit('passenger_left', { id: socket.id });
        }
      } catch (err) {
        console.error('[socket] disconnect Redis error:', err.message);
      }
      db.query('DELETE FROM bridgemeet_pool WHERE user_id = $1', [userId]).catch(() => {});
      db.query(
        'UPDATE users SET is_online = false WHERE id = $1',
        [userId]
      ).catch(() => {});
    });
  });

  return io;
}

function getIO() {
  if (!io) throw new Error('Socket.io not initialised — call socketService.init(httpServer) first');
  return io;
}

module.exports = { init, getIO };
