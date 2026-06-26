import { sendPushNotification } from '../services/vapidService.js';
import { sendEmail } from '../services/emailService.js';
import { allocateInitialPoints } from '../services/loyaltyService.js';
import db from '../services/db.js';

export async function handleMerchantWebhook(event, data) {
    if (event === 'merchant.onboarded') {
        const { userId, countryCode, email, businessTier } = data;

        // 1. Trigger VAPID Push Notification
        await sendPushNotification(userId, "Welcome to the BridgePro network! Your shop is now live.");

        // 2. Send Transactional Email
        await sendEmail({
            to: email,
            subject: "BridgePro Merchant Activation",
            text: "Your business is verified and active on the marketplace."
        });

        // 3. Seed Loyalty Profile Limits
        await allocateInitialPoints(userId, countryCode, businessTier);
        
        console.log(`Merchant ${userId} successfully activated for ${countryCode}`);
    }
}
