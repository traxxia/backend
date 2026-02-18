const Stripe = require('stripe');
const { STRIPE_SECRET_KEY } = require('../config/constants');

const stripe = new Stripe(STRIPE_SECRET_KEY);

class StripeService {
    static async createCustomer(email, name, paymentMethodId) {
        try {
            const customer = await stripe.customers.create({
                email,
                name,
                payment_method: paymentMethodId,
                invoice_settings: {
                    default_payment_method: paymentMethodId,
                },
            });
            return customer;
        } catch (error) {
            console.error('Error creating Stripe customer:', error);
            throw error; // Re-throw to be handled by controller
        }
    }

    static async createSubscription(customerId, priceId) {
        try {
            const subscription = await stripe.subscriptions.create({
                customer: customerId,
                items: [{ price: priceId }],
                expand: ['latest_invoice.payment_intent'],
            });
            return subscription;
        } catch (error) {
            console.error('Error creating Stripe subscription:', error);
            throw error;
        }
    }

    static async retrievePaymentMethod(paymentMethodId) {
        try {
            return await stripe.paymentMethods.retrieve(paymentMethodId);
        } catch (error) {
            console.error("Error retrieving payment method:", error);
            throw error;
        }
    }
}

module.exports = StripeService;
