const SEARCH_PROVIDERS_TOOL = {
  name: 'search_providers',
  description: 'Search for local service providers on the BridgePro marketplace by keyword or category.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query string to find matching providers or services',
      },
      category: {
        type: 'string',
        description: 'Optional category to filter results (e.g. "Plumbing", "Catering")',
      },
    },
    required: ['query'],
  },
};

const SEARCH_PRODUCTS_TOOL = {
  name: 'search_products',
  description: 'Search for products sold by businesses on the BridgePro marketplace.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query to match product name, description, or category',
      },
      max_price: {
        type: 'number',
        description: 'Optional maximum price filter — returns products at or below this price',
      },
    },
    required: ['query'],
  },
};

const CREATE_APPOINTMENT_TOOL = {
  name: 'create_appointment',
  description: 'Create a scheduled appointment reminder for the current user. ' +
    'For RELATIVE times ("in 5 minutes", "in 2 hours", "in 30 minutes") — pass minutes_from_now and omit appointment_at; the server computes the exact timestamp. ' +
    'For ABSOLUTE times ("tomorrow at 3pm", "next Tuesday at noon", "June 25th at 10am") — pass appointment_at in ISO 8601 SVG local time and omit minutes_from_now.',
  input_schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Short title or description of the appointment (e.g. "Dentist visit", "Meet with plumber")',
      },
      appointment_at: {
        type: 'string',
        description: 'Use for ABSOLUTE times only. ISO 8601 datetime in SVG local time, e.g. "2026-06-23T14:30:00". Never include a UTC offset. Do NOT use this for relative phrases like "in 5 minutes" — use minutes_from_now instead.',
      },
      minutes_from_now: {
        type: 'integer',
        description: 'Use for RELATIVE times only ("in 5 minutes" → 5, "in 2 hours" → 120). The server computes the exact SVG timestamp. Do NOT use this for absolute dates — use appointment_at instead.',
      },
      provider_id: {
        type: 'string',
        description: 'Optional UUID of a BridgePro provider user associated with this appointment',
      },
      listing_id: {
        type: 'string',
        description: 'Optional UUID of a BridgePro listing associated with this appointment',
      },
      reminder_minutes_before: {
        type: 'integer',
        description: 'How many minutes before the appointment to send the push notification reminder. Must be at least 1 — zero is not valid. Must be explicitly provided — always ask the user before calling this tool if they have not stated a reminder window.',
      },
    },
    required: ['title', 'reminder_minutes_before'],
  },
};

const LIST_APPOINTMENTS_TOOL = {
  name: 'list_upcoming_appointments',
  description: 'List all upcoming scheduled appointments for the current user, ordered by soonest first.',
  input_schema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

const CANCEL_APPOINTMENT_TOOL = {
  name: 'cancel_appointment',
  description: 'Cancel a scheduled appointment belonging to the current user.',
  input_schema: {
    type: 'object',
    properties: {
      appointment_id: {
        type: 'integer',
        description: 'The integer ID of the appointment to cancel (from list_upcoming_appointments results)',
      },
    },
    required: ['appointment_id'],
  },
};

const CUSTOMER_TOOLS = [
  SEARCH_PROVIDERS_TOOL,
  SEARCH_PRODUCTS_TOOL,
  CREATE_APPOINTMENT_TOOL,
  LIST_APPOINTMENTS_TOOL,
  CANCEL_APPOINTMENT_TOOL,
  {
    name: 'send_enquiry',
    description: 'Send an enquiry message to a specific service provider listing, or reply to an existing conversation.',
    input_schema: {
      type: 'object',
      properties: {
        listing_id: {
          type: 'string',
          description: 'The UUID of the provider listing to enquire about (from search_providers results). Required if conversation_id is not provided.',
        },
        message: {
          type: 'string',
          description: 'The enquiry message to send to the provider',
        },
        conversation_id: {
          type: 'string',
          description: 'If you already have a conversation ID from get_my_enquiries, provide it here to reply to an existing conversation instead of starting a new one',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'get_my_enquiries',
    description: 'Retrieve all enquiries sent by the current customer.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_conversation_thread',
    description: 'Get the full message history of a specific conversation. Use this when you need context about what was previously discussed in a conversation before responding.',
    input_schema: {
      type: 'object',
      properties: {
        conversation_id: {
          type: 'integer',
          description: 'The integer ID of the conversation to retrieve messages for',
        },
      },
      required: ['conversation_id'],
    },
  },
  {
    name: 'cancel_enquiry',
    description: 'Cancel or withdraw a pending enquiry/service request. Customer only.',
    input_schema: {
      type: 'object',
      properties: {
        enquiry_id: {
          type: 'integer',
          description: 'The integer ID of the enquiry/conversation to cancel (from get_my_enquiries results)',
        },
        reason: {
          type: 'string',
          description: 'Optional reason for withdrawing the enquiry',
        },
      },
      required: ['enquiry_id'],
    },
  },
  {
    name: 'submit_review',
    description: 'Submit a review for a completed, verified transaction/job. Customer only. Requires ID verification.',
    input_schema: {
      type: 'object',
      properties: {
        transaction_id: {
          type: 'string',
          description: 'The UUID of the completed, verified transaction/job to review (from your transactions/jobs list)',
        },
        rating: {
          type: 'integer',
          description: 'Rating score from 1 to 5 (1 = lowest, 5 = highest)',
        },
        body: {
          type: 'string',
          description: 'Optional written review details summarizing your experience',
        },
      },
      required: ['transaction_id', 'rating'],
    },
  },
  {
    name: 'get_reviews',
    description: 'Retrieve reviews for a provider listing.',
    input_schema: {
      type: 'object',
      properties: {
        listing_id: {
          type: 'string',
          description: 'The UUID of the provider listing to fetch reviews for',
        },
      },
      required: ['listing_id'],
    },
  },
  {
    name: 'get_recommendations',
    description: 'Retrieve personalized concierge recommendations for service listings. general use.',
    input_schema: {
      type: 'object',
      properties: {
        user_id: {
          type: 'string',
          description: 'Optional target user UUID to query personalized interests for (defaults to current user)',
        },
      },
      required: [],
    },
  },
  {
    name: 'propose_slots',
    description: 'Query a provider\'s calendar for the next 7 days and suggest the 3 best available time slots. general use.',
    input_schema: {
      type: 'object',
      properties: {
        provider_id: {
          type: 'string',
          description: 'The UUID of the service provider to retrieve available slots for',
        },
      },
      required: ['provider_id'],
    },
  },
  {
    name: 'initiate_booking',
    description: 'Propose an appointment booking slot with a service provider, setting its status to pending provider approval. general use.',
    input_schema: {
      type: 'object',
      properties: {
        provider_id: {
          type: 'string',
          description: 'The UUID of the service provider to book with',
        },
        start_time: {
          type: 'string',
          description: 'ISO 8601 datetime format for the slot (e.g. "2026-06-25T14:00:00")',
        },
        title: {
          type: 'string',
          description: 'A short description/title for the appointment booking (e.g., "Hair styling session")',
        },
      },
      required: ['provider_id', 'start_time', 'title'],
    },
  },
];

const ANALYZE_IMAGE_TOOL = {
  name: 'analyze_image',
  description: 'Analyze an uploaded image using AI vision to suggest product name, description, price and category. Use when provider uploads a photo and wants to create a product listing from it.',
  input_schema: {
    type: 'object',
    properties: {
      image_url: { type: 'string', description: 'URL of the uploaded image' },
      type: { type: 'string', enum: ['product', 'listing'], description: 'Type of analysis' }
    },
    required: ['image_url', 'type']
  }
};

const PROVIDER_TOOLS = [
  ANALYZE_IMAGE_TOOL,
  {
    name: 'mark_job_complete',
    description: 'Mark a scheduled appointment/job as completed. Provider only.',
    input_schema: {
      type: 'object',
      properties: {
        job_id: {
          type: 'integer',
          description: 'The integer ID of the appointment/job to complete (from provider list_upcoming_appointments or search)',
        },
        completion_note: {
          type: 'string',
          description: 'Optional note summarizing the completion details',
        },
      },
      required: ['job_id'],
    },
  },
  {
    name: 'get_incoming_enquiries',
    description: 'Retrieve recent conversations/enquiries sent to the provider\'s listings, including the integer conversation_id needed for respond_to_enquiry.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_my_listings',
    description: 'Retrieve all listings belonging to the current provider.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'respond_to_enquiry',
    description: 'Send a response to a customer enquiry. enquiry_id is the INTEGER conversation ID returned by get_incoming_enquiries (e.g. 11, 12). It is NOT the listing UUID. Always call get_incoming_enquiries first to get the correct integer ID before calling this tool.',
    input_schema: {
      type: 'object',
      properties: {
        enquiry_id: {
          type: 'string',
          description: 'enquiry_id is the INTEGER conversation ID returned by get_incoming_enquiries (e.g. 11, 12). It is NOT the listing UUID. Always call get_incoming_enquiries first to get the correct integer ID before calling this tool.',
        },
        message: {
          type: 'string',
          description: 'The response message to send to the customer',
        },
      },
      required: ['enquiry_id', 'message'],
    },
  },
  {
    name: 'draft_invoice',
    description: 'Draft an invoice for a completed or agreed job from an enquiry.',
    input_schema: {
      type: 'object',
      properties: {
        enquiry_id: {
          type: 'string',
          description: 'The conversation_id number from get_incoming_enquiries or get_my_enquiries results (e.g. "11" or "12") — NOT a listing UUID',
        },
        amount: {
          type: 'number',
          description: 'The invoice amount in XCD',
        },
        description: {
          type: 'string',
          description: 'Description of the services rendered for this invoice',
        },
      },
      required: ['enquiry_id', 'amount', 'description'],
    },
  },
  {
    name: 'update_listing_status',
    description: 'Activate or deactivate a provider listing.',
    input_schema: {
      type: 'object',
      properties: {
        listing_id: {
          type: 'string',
          description: 'The UUID of the listing to update (from get_my_listings results)',
        },
        is_active: {
          type: 'boolean',
          description: 'Set to true to activate the listing, false to deactivate it',
        },
      },
      required: ['listing_id', 'is_active'],
    },
  },
  {
    name: 'get_my_products',
    description: 'Retrieve products belonging to the current provider, optionally filtered by listing.',
    input_schema: {
      type: 'object',
      properties: {
        listing_id: {
          type: 'string',
          description: 'Optional UUID of a specific listing to filter products by',
        },
      },
      required: [],
    },
  },
  {
    name: 'create_product',
    description: 'Add a new product to one of the provider\'s listings.',
    input_schema: {
      type: 'object',
      properties: {
        listing_id: {
          type: 'string',
          description: 'UUID of the listing this product belongs to (from get_my_listings)',
        },
        name: {
          type: 'string',
          description: 'Product name',
        },
        price: {
          type: 'number',
          description: 'Product price',
        },
        description: {
          type: 'string',
          description: 'Product description',
        },
        category: {
          type: 'string',
          description: 'Product category',
        },
        unit: {
          type: 'string',
          description: 'Unit of sale (e.g. "each", "per kg", "per litre")',
        },
        in_stock: {
          type: 'boolean',
          description: 'Whether the product is currently in stock (defaults to true)',
        },
        currency: {
          type: 'string',
          description: 'Currency code (defaults to XCD)',
        },
      },
      required: ['listing_id', 'name'],
    },
  },
  {
    name: 'update_product',
    description: 'Update an existing product — price, deal/sale price, stock status, or details. For deal_expires you can pass natural strings like "end of month" or "end of year".',
    input_schema: {
      type: 'object',
      properties: {
        product_id: {
          type: 'string',
          description: 'UUID of the product to update (from get_my_products)',
        },
        name: {
          type: 'string',
          description: 'New product name',
        },
        description: {
          type: 'string',
          description: 'New product description',
        },
        price: {
          type: 'number',
          description: 'New regular price',
        },
        deal_price: {
          type: 'number',
          description: 'Sale/deal price (shown alongside regular price)',
        },
        deal_expires: {
          type: 'string',
          description: 'When the deal expires — accepts ISO date strings or natural language like "end of month", "end of year"',
        },
        in_stock: {
          type: 'boolean',
          description: 'Set to false to mark as out of stock',
        },
      },
      required: ['product_id'],
    },
  },
  {
    name: 'confirm_booking',
    description: 'Confirm a proposed pending appointment booking slot. Provider only.',
    input_schema: {
      type: 'object',
      properties: {
        appointment_id: {
          type: 'integer',
          description: 'The integer ID of the pending appointment to confirm',
        },
      },
      required: ['appointment_id'],
    },
  },
  {
    name: 'auto_list_service',
    description: 'Automatically create a product/service listing from an image URL by analyzing its content. Provider only.',
    input_schema: {
      type: 'object',
      properties: {
        image_url: {
          type: 'string',
          description: 'URL of the uploaded image to analyze and list (e.g. "/tmp/agent-uploads/product.jpg" or full URL)',
        },
        provider_id: {
          type: 'string',
          description: 'Optional provider UUID to associate the product/service with (defaults to current user)',
        },
        listing_id: {
          type: 'string',
          description: 'Optional business listing ID to associate the product with',
        },
      },
      required: ['image_url'],
    },
  },
];

const ADMIN_TOOLS = [
  {
    name: 'get_platform_stats',
    description: 'Retrieve overall platform statistics including user counts, listing counts, and activity metrics.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_pending_listings',
    description: 'Retrieve all listings pending admin review or approval.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'approve_listing',
    description: 'Approve or reject a pending provider listing. Admin only.',
    input_schema: {
      type: 'object',
      properties: {
        listing_id: {
          type: 'string',
          description: 'The UUID of the listing to approve or reject (from get_pending_listings results)',
        },
        action: {
          type: 'string',
          enum: ['approve', 'reject'],
          description: 'The action to take: "approve" to make listing active, "reject" to deny it',
        },
        reason: {
          type: 'string',
          description: 'Reason for rejection (required if action is reject, optional if approve)',
        },
      },
      required: ['listing_id', 'action'],
    },
  },
  {
    name: 'view_audit_log',
    description: 'Retrieve system audit logs for administrative review. Admin only.',
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: 'Maximum number of log entries to retrieve (default 50, max 200)',
        },
        action: {
          type: 'string',
          description: 'Optional action filter (e.g. "listing_approved", "listing_rejected")',
        },
      },
      required: [],
    },
  },
];

function getToolsForRole(role) {
  switch (role) {
    case 'customer': return [...CUSTOMER_TOOLS, ...PROVIDER_TOOLS];
    case 'provider': return [...CUSTOMER_TOOLS, ...PROVIDER_TOOLS];
    case 'admin':    return [...CUSTOMER_TOOLS, ...PROVIDER_TOOLS, ...ADMIN_TOOLS];
    default:         return [SEARCH_PROVIDERS_TOOL, SEARCH_PRODUCTS_TOOL];
  }
}

function toGroqFormat(anthropicTools) {
  return anthropicTools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

function getGroqToolsForRole(role) {
  return toGroqFormat(getToolsForRole(role));
}

module.exports = { getToolsForRole, getGroqToolsForRole };
