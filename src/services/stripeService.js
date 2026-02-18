const Stripe = require('stripe');
const { STRIPE_SECRET_KEY } = require('../config/constants');

const stripe = new Stripe(STRIPE_SECRET_KEY);

class StripeService {
    static async createCustomer(email, name, paymentMethodId, setAsDefault = true) {
        try {
            const customerData = {
                email,
                name,
                payment_method: paymentMethodId,
            };

            if (setAsDefault && paymentMethodId) {
                customerData.invoice_settings = {
                    default_payment_method: paymentMethodId,
                };
            }

            const customer = await stripe.customers.create(customerData);
            return customer;
        } catch (error) {
            console.error('Error creating Stripe customer:', error);
            throw error; // Re-throw to be handled by controller
        }
    }

    static async createSubscription(customerId, priceId, paymentMethodId = null) {
        try {
            const subscriptionData = {
                customer: customerId,
                items: [{ price: priceId }],
                expand: ['latest_invoice.payment_intent'],
            };

            if (paymentMethodId) {
                subscriptionData.default_payment_method = paymentMethodId;
            }

            const subscription = await stripe.subscriptions.create(subscriptionData);
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

    static async attachPaymentMethod(paymentMethodId, customerId) {
        try {
            return await stripe.paymentMethods.attach(paymentMethodId, {
                customer: customerId,
            });
        } catch (error) {
            console.error("Error attaching payment method:", error);
            throw error;
        }
    }

    static async updateCustomer(customerId, updateData) {
        try {
            return await stripe.customers.update(customerId, updateData);
        } catch (error) {
            console.error("Error updating customer:", error);
            throw error;
        }
    }

    static async listPaymentMethods(customerId) {
        try {
            const paymentMethods = await stripe.paymentMethods.list({
                customer: customerId,
                type: 'card',
            });
            return paymentMethods.data;
        } catch (error) {
            console.error("Error listing payment methods:", error);
            throw error;
        }
    }
}

module.exports = StripeService;
