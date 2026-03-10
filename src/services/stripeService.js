const Stripe = require('stripe');
const { STRIPE_SECRET_KEY } = require('../config/constants');

if (!STRIPE_SECRET_KEY) {
    console.error('STRIPE_SECRET_KEY is missing in environment variables.');
}

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

class StripeService {
    static async createProductAndPrice(name, description, priceAmount) {
        try {
            const product = await stripe.products.create({
                name,
                description: description || name,
            });

            const price = await stripe.prices.create({
                product: product.id,
                unit_amount: Math.round(priceAmount * 100), // Assumes amount is in dollars
                currency: 'usd',
                recurring: { interval: 'month' }, // Assumes monthly billing
            });

            return price.id;
        } catch (error) {
            console.error('Error creating Stripe product/price:', error);
            throw error;
        }
    }
    
    static async createCustomer(email, name, paymentMethodId, setAsDefault = true) {
        try {
            const customerData = {
                email,
                name,
            };

            // 1. Create Customer
            const customer = await stripe.customers.create(customerData);

            // 2. Attach Payment Method if provided
            if (paymentMethodId) {
                await stripe.paymentMethods.attach(paymentMethodId, {
                    customer: customer.id,
                });

                // 3. Set as default if requested
                if (setAsDefault) {
                    await stripe.customers.update(customer.id, {
                        invoice_settings: { default_payment_method: paymentMethodId },
                    });
                }
            }

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

    static async retrieveSubscription(subscriptionId) {
        try {
            return await stripe.subscriptions.retrieve(subscriptionId);
        } catch (error) {
            console.error("Error retrieving subscription:", error);
            throw error;
        }
    }

    static async updateSubscription(subscriptionId, updateData) {
        try {
            console.log(`[Stripe] 📤 Updating Subscription ${subscriptionId}:`, JSON.stringify(updateData));
            // Expand latest_invoice to get the invoice URL immediately for proactive sync
            return await stripe.subscriptions.update(subscriptionId, {
                ...updateData,
                expand: ['latest_invoice']
            });
        } catch (error) {
            console.error("Error updating subscription:", error);
            throw error;
        }
    }

    static constructEvent(payload, sig, secret) {
        try {
            return stripe.webhooks.constructEvent(payload, sig, secret);
        } catch (error) {
            console.error('Webhook signature verification failed:', error.message);
            throw error;
        }
    }
}

module.exports = StripeService;

