import nodemailer from 'nodemailer';
import crypto from 'crypto';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_PORT === '465',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

export function generateVerificationToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function getVerificationEmailHTML(name: string, verificationLink: string): string {
  return `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verifica tu cuenta - EfficoreChat</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0A0F1C; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" style="max-width: 500px; width: 100%; border-collapse: collapse;">
          
          <!-- Logo -->
          <tr>
            <td align="center" style="padding-bottom: 30px;">
              <table role="presentation" style="border-collapse: collapse;">
                <tr>
                  <td style="vertical-align: middle; padding-right: 10px;">
                    <div style="width: 40px; height: 40px; border: 2px solid #00D4FF; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center;">
                      <span style="color: #00D4FF; font-size: 20px;">▶</span>
                    </div>
                  </td>
                  <td style="vertical-align: middle;">
                    <span style="font-size: 24px; font-weight: bold; color: #FFFFFF;">Efficore</span><span style="font-size: 24px; font-weight: bold; color: #00D4FF;">Chat</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Card -->
          <tr>
            <td style="background-color: #1F2937; border-radius: 16px; padding: 40px 30px;">
              
              <!-- Icon -->
              <table role="presentation" style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td align="center" style="padding-bottom: 20px;">
                    <div style="width: 60px; height: 60px; background-color: rgba(0, 212, 255, 0.1); border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;">
                      <span style="font-size: 28px;">✉️</span>
                    </div>
                  </td>
                </tr>
              </table>
              
              <!-- Title -->
              <table role="presentation" style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td align="center" style="padding-bottom: 10px;">
                    <h1 style="margin: 0; color: #FFFFFF; font-size: 22px; font-weight: 600;">Confirma tu correo electrónico</h1>
                  </td>
                </tr>
              </table>
              
              <!-- Message -->
              <table role="presentation" style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td align="center" style="padding-bottom: 30px;">
                    <p style="margin: 0; color: #9CA3AF; font-size: 15px; line-height: 1.6;">
                      Hola <strong style="color: #FFFFFF;">${name}</strong>,<br><br>
                      Gracias por registrarte en EfficoreChat. Para completar tu registro y poder crear instancias de WhatsApp, necesitamos verificar tu correo electrónico.
                    </p>
                  </td>
                </tr>
              </table>
              
              <!-- Button -->
              <table role="presentation" style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td align="center" style="padding-bottom: 30px;">
                    <a href="${verificationLink}" style="display: inline-block; background-color: #00D4FF; color: #0A0F1C; text-decoration: none; font-weight: 600; font-size: 16px; padding: 14px 40px; border-radius: 8px;">
                      Verificar mi correo
                    </a>
                  </td>
                </tr>
              </table>
              
              <!-- Alternative link -->
              <table role="presentation" style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td align="center">
                    <p style="margin: 0; color: #6B7280; font-size: 13px; line-height: 1.6;">
                      Si el botón no funciona, copia y pega este enlace en tu navegador:
                    </p>
                    <p style="margin: 10px 0 0 0; word-break: break-all;">
                      <a href="${verificationLink}" style="color: #00D4FF; font-size: 12px; text-decoration: none;">${verificationLink}</a>
                    </p>
                  </td>
                </tr>
              </table>
              
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top: 30px;">
              <p style="margin: 0; color: #6B7280; font-size: 12px;">
                Este enlace expira en 24 horas.<br>
                Si no solicitaste esta verificación, puedes ignorar este correo.
              </p>
              <p style="margin: 20px 0 0 0; color: #4B5563; font-size: 11px;">
                © ${new Date().getFullYear()} EfficoreChat. Todos los derechos reservados.
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
}

export async function sendVerificationEmail(
  email: string,
  name: string,
  token: string,
  appDomain: string
): Promise<boolean> {
  const verificationLink = `${appDomain}/verify-email?token=${token}`;
  
  try {
    await transporter.sendMail({
      from: `"${process.env.SMTP_FROM_NAME || 'EfficoreChat'}" <${process.env.SMTP_FROM_EMAIL}>`,
      to: email,
      subject: 'Confirma tu correo electrónico - EfficoreChat',
      html: getVerificationEmailHTML(name, verificationLink)
    });
    
    console.log(`Verification email sent to ${email}`);
    return true;
  } catch (error) {
    console.error('Failed to send verification email:', error);
    return false;
  }
}

export async function testSMTPConnection(): Promise<boolean> {
  try {
    await transporter.verify();
    console.log('SMTP connection verified successfully');
    return true;
  } catch (error) {
    console.error('SMTP connection failed:', error);
    return false;
  }
}
