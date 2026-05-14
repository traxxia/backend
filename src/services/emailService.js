const TENANT_ID = process.env.MS_TENANT_ID;
const CLIENT_ID = process.env.MS_CLIENT_ID;
const CLIENT_SECRET = process.env.MS_CLIENT_SECRET;
const SENDER = process.env.MS_SENDER;

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://app.traxxia.ai';

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
      <!DOCTYPE html>
      <html>
      <body style="margin: 0; padding: 0; background-color: #f6f9fc; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;">
        <table border="0" cellpadding="0" cellspacing="0" width="100%">
          <tr>
            <td align="center" style="padding: 40px 0;">
              <table border="0" cellpadding="0" cellspacing="0" width="600" style="background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                <tr>
                  <td align="center" style="padding: 40px 40px 20px 40px;">
                    <h1 style="margin: 0; color: #1a1f36; font-size: 24px; font-weight: 700;">Reset Your Password</h1>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 20px 40px; color: #4f566b; font-size: 16px; line-height: 24px;">
                    <p style="margin: 0;">Your OTP for password reset is:</p>
                    <div style="text-align: center; margin: 30px 0;">
                      <span style="display: inline-block; padding: 15px 30px; background-color: #f8f9fa; border: 1px dashed #007bff; color: #007bff; font-size: 28px; font-weight: bold; letter-spacing: 5px; border-radius: 5px;">${otp}</span>
                    </div>
                    <p style="margin: 0;">This code will expire in 5 minutes.</p>
                    <p style="margin: 10px 0 0 0;">If you didn't request this, you can safely ignore this email.</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 30px 40px; background-color: #f8f9fa; border-top: 1px solid #e3e8ee;">
                    <p style="margin: 0; font-size: 14px; color: #8898aa;">
                      Best regards,<br>
                      <strong>The Traxxia Team</strong>
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `;
    const text = `Your OTP for password reset is: ${otp}. It will expire in 5 minutes.`;
    return this.sendMailViaGraph({ to, subject, html, text });
  }

  /**
   * Sends a notification email when projects/bets are ranked.
   */
  static async sendRankingNotification(to, { userName, businessName, isAdminAction }) {
    const subject = isAdminAction ? "Action Required: Project Ranking Update" : "Update: Collaborator Ranked Projects";
    const title = isAdminAction ? "Time to Rank Projects" : "Ranking Update";
    const message = isAdminAction 
      ? `The admin has ranked the projects for <strong>${businessName || 'the business'}</strong>. Please review and rank your projects.`
      : `Collaborator <strong>${userName || 'A user'}</strong> has ranked their projects for <strong>${businessName || 'the business'}</strong>.`;
    
    const html = `
      <!DOCTYPE html>
      <html>
      <body style="margin: 0; padding: 0; background-color: #f6f9fc; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;">
        <table border="0" cellpadding="0" cellspacing="0" width="100%">
          <tr>
            <td align="center" style="padding: 40px 0;">
              <table border="0" cellpadding="0" cellspacing="0" width="600" style="background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                <tr>
                  <td align="center" style="padding: 40px 40px 20px 40px;">
                    <h1 style="margin: 0; color: #1a1f36; font-size: 24px; font-weight: 700;">${title}</h1>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 20px 40px; color: #4f566b; font-size: 16px; line-height: 24px;">
                    <p style="margin: 0;">${message}</p>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding: 10px 40px 40px 40px;">
                    <table border="0" cellpadding="0" cellspacing="0">
                      <tr>
                        <td align="center" style="border-radius: 5px; background-color: #007bff;">
                          <a href="${FRONTEND_URL}" target="_blank" style="display: inline-block; padding: 14px 28px; font-size: 16px; font-weight: 600; color: #ffffff; text-decoration: none;">View Rankings</a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 30px 40px; background-color: #f8f9fa; border-top: 1px solid #e3e8ee;">
                    <p style="margin: 0; font-size: 14px; color: #8898aa;">
                      Best regards,<br>
                      <strong>The Traxxia Team</strong>
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `;
    const text = isAdminAction 
      ? `The admin has ranked the projects for "${businessName}". Please review and rank your projects.`
      : `Collaborator ${userName} has ranked their projects for "${businessName}".`;
    
    return this.sendMailViaGraph({ to, subject, html, text });
  }

  /**
   * Sends a review reminder or stale project notification.
   */
  static async sendReviewReminder(to, { projectName, businessName, notificationType }) {
    const isStale = notificationType === 'stale_bet';
    const subject = isStale ? `Action Required: Project "${projectName}" is Overdue` : `Reminder: Review for "${projectName}" Tomorrow`;
    const title = isStale ? "Project Overdue" : "Review Reminder";
    const message = isStale 
      ? `The project <strong>${projectName}</strong> under <strong>${businessName}</strong> is overdue for its scheduled review. Please update its status or perform a review as soon as possible.`
      : `Friendly reminder that the project <strong>${projectName}</strong> under <strong>${businessName}</strong> is scheduled for its periodic review tomorrow.`;
    
    const html = `
      <!DOCTYPE html>
      <html>
      <body style="margin: 0; padding: 0; background-color: #f6f9fc; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;">
        <table border="0" cellpadding="0" cellspacing="0" width="100%">
          <tr>
            <td align="center" style="padding: 40px 0;">
              <table border="0" cellpadding="0" cellspacing="0" width="600" style="background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                <tr>
                  <td align="center" style="padding: 40px 40px 20px 40px;">
                    <h1 style="margin: 0; color: ${isStale ? '#dc3545' : '#1a1f36'}; font-size: 24px; font-weight: 700;">${title}</h1>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 20px 40px; color: #4f566b; font-size: 16px; line-height: 24px;">
                    <p style="margin: 0;">${message}</p>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding: 10px 40px 40px 40px;">
                    <table border="0" cellpadding="0" cellspacing="0">
                      <tr>
                        <td align="center" style="border-radius: 5px; background-color: #007bff;">
                          <a href="${FRONTEND_URL}" target="_blank" style="display: inline-block; padding: 14px 28px; font-size: 16px; font-weight: 600; color: #ffffff; text-decoration: none;">Go to Projects</a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 30px 40px; background-color: #f8f9fa; border-top: 1px solid #e3e8ee;">
                    <p style="margin: 0; font-size: 14px; color: #8898aa;">
                      Best regards,<br>
                      <strong>The Traxxia Team</strong>
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `;
    const text = isStale 
      ? `The project "${projectName}" under "${businessName}" is overdue for its scheduled review.`
      : `Friendly reminder that the project "${projectName}" under "${businessName}" is scheduled for its review tomorrow.`;
    
    return this.sendMailViaGraph({ to, subject, html, text });
  }
}

module.exports = EmailService;

