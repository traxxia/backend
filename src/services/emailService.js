const TENANT_ID = process.env.MS_TENANT_ID;
const CLIENT_ID = process.env.MS_CLIENT_ID;
const CLIENT_SECRET = process.env.MS_CLIENT_SECRET;
const SENDER = process.env.MS_SENDER;

/**
 * EmailService
 * Handles sending emails using Microsoft Graph API via fetch.
 */
class EmailService {
  /**
   * Gets an access token for Microsoft Graph API.
   * Uses Node 18+ native fetch.
   */
  static async getGraphAccessToken() {
    if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) {
      throw new Error('Microsoft Graph API credentials (TENANT_ID, CLIENT_ID, CLIENT_SECRET) are missing');
    }

    const tokenEndpoint = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    });

    const resp = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });

    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(
        `Graph token error: ${resp.status} ${
          data.error_description || JSON.stringify(data)
        }`
      );
    }
    return data.access_token;
  }

  /**
   * Sends an email via Microsoft Graph API.
   */
  static async sendMailViaGraph({ to, subject, html, text }) {
    try {
      const accessToken = await this.getGraphAccessToken();
      const sender = SENDER || 'info@traxxia.ai';
      const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`;

      const body = {
        message: {
          subject,
          body: {
            contentType: html ? "HTML" : "Text",
            content: html || text || "",
          },
          toRecipients: [{ emailAddress: { address: to } }],
        },
        saveToSentItems: "false",
      };

      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Graph sendMail failed: ${resp.status} ${errText}`);
      }

      console.log(`[EmailService] Email sent successfully to ${to}`);
    } catch (error) {
      console.error('Error in sendMailViaGraph:', error);
      throw error;
    }
  }

  /**
   * Specifically for password reset OTP.
   */
  static async sendPasswordResetOtp(to, otp) {
    const subject = "Password Reset OTP";
    const html = `
      <div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
        <h2 style="color: #333;">Reset Your Password</h2>
        <p>Your OTP for password reset is:</p>
        <div style="text-align: center; margin: 30px 0;">
          <span style="display: inline-block; padding: 15px 30px; background-color: #f8f9fa; border: 1px dashed #007bff; color: #007bff; font-size: 24px; font-weight: bold; letter-spacing: 5px; border-radius: 5px;">${otp}</span>
        </div>
        <p>This code will expire in 5 minutes.</p>
        <p>If you didn't request this, you can safely ignore this email.</p>
        <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
        <p style="font-size: 12px; color: #888;">Best regards,<br>The Traxxia Team</p>
      </div>
    `;
    const text = `Your OTP for password reset is: ${otp}. It will expire in 5 minutes.`;
    
    return this.sendMailViaGraph({ to, subject, html, text });
  }
}

module.exports = EmailService;

