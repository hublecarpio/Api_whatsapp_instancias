import nodemailer from 'nodemailer';
import crypto from 'crypto';

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (!transporter) {
    const smtpHost = process.env.SMTP_HOST;
    const smtpPort = parseInt(process.env.SMTP_PORT || '587');
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    
    console.log('Initializing SMTP transporter:', {
      host: smtpHost,
      port: smtpPort,
      user: smtpUser ? `${smtpUser.substring(0, 3)}...` : 'NOT SET',
      secure: smtpPort === 465
    });
    
    if (!smtpHost || !smtpUser || !smtpPass) {
      console.error('SMTP configuration incomplete:', {
        host: !!smtpHost,
        user: !!smtpUser,
        pass: !!smtpPass
      });
    }
    
    transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: {
        user: smtpUser,
        pass: smtpPass
      },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000
    });
  }
  return transporter;
}

export function generateVerificationToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function getVerificationEmailHTML(name: string, verificationLink: string, appDomain: string): string {
  const logoUrl = `${appDomain}/icon-192.png`;
  
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
                  <td style="vertical-align: middle; padding-right: 12px;">
                    <img src="${logoUrl}" alt="EfficoreChat" width="44" height="44" style="display: block; border-radius: 8px;" />
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
    const transport = getTransporter();
    const fromEmail = process.env.SMTP_FROM_EMAIL;
    const fromName = process.env.SMTP_FROM_NAME || 'EfficoreChat';
    
    console.log('Attempting to send verification email:', {
      to: email,
      from: `${fromName} <${fromEmail}>`,
      link: verificationLink.substring(0, 50) + '...'
    });
    
    const result = await transport.sendMail({
      from: `"${fromName}" <${fromEmail}>`,
      to: email,
      subject: 'Confirma tu correo electrónico - EfficoreChat',
      html: getVerificationEmailHTML(name, verificationLink, appDomain)
    });
    
    console.log(`Verification email sent successfully to ${email}`, {
      messageId: result.messageId,
      response: result.response
    });
    return true;
  } catch (error: any) {
    console.error('Failed to send verification email:', {
      to: email,
      errorCode: error.code,
      errorMessage: error.message,
      errorResponse: error.response,
      errorCommand: error.command,
      fullError: error.toString()
    });
    return false;
  }
}

export async function testSMTPConnection(): Promise<boolean> {
  try {
    const transport = getTransporter();
    await transport.verify();
    console.log('SMTP connection verified successfully');
    return true;
  } catch (error: any) {
    console.error('SMTP connection failed:', {
      code: error.code,
      message: error.message,
      response: error.response,
      command: error.command
    });
    return false;
  }
}

function getPasswordResetEmailHTML(name: string, resetLink: string, appDomain: string): string {
  const logoUrl = `${appDomain}/icon-192.png`;
  
  return `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Restablecer contraseña - EfficoreChat</title>
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
                  <td style="vertical-align: middle; padding-right: 12px;">
                    <img src="${logoUrl}" alt="EfficoreChat" width="44" height="44" style="display: block; border-radius: 8px;" />
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
                      <span style="font-size: 28px;">🔐</span>
                    </div>
                  </td>
                </tr>
              </table>
              
              <!-- Title -->
              <table role="presentation" style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td align="center" style="padding-bottom: 10px;">
                    <h1 style="margin: 0; color: #FFFFFF; font-size: 22px; font-weight: 600;">Restablecer contraseña</h1>
                  </td>
                </tr>
              </table>
              
              <!-- Message -->
              <table role="presentation" style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td align="center" style="padding-bottom: 30px;">
                    <p style="margin: 0; color: #9CA3AF; font-size: 15px; line-height: 1.6;">
                      Hola <strong style="color: #FFFFFF;">${name}</strong>,<br><br>
                      Recibimos una solicitud para restablecer la contraseña de tu cuenta. Haz clic en el botón de abajo para crear una nueva contraseña.
                    </p>
                  </td>
                </tr>
              </table>
              
              <!-- Button -->
              <table role="presentation" style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td align="center" style="padding-bottom: 30px;">
                    <a href="${resetLink}" style="display: inline-block; background-color: #00D4FF; color: #0A0F1C; text-decoration: none; font-weight: 600; font-size: 16px; padding: 14px 40px; border-radius: 8px;">
                      Restablecer contraseña
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
                      <a href="${resetLink}" style="color: #00D4FF; font-size: 12px; text-decoration: none;">${resetLink}</a>
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
                Este enlace expira en 1 hora.<br>
                Si no solicitaste restablecer tu contraseña, puedes ignorar este correo.
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

export async function sendPasswordResetEmail(
  email: string,
  name: string,
  token: string,
  appDomain: string
): Promise<boolean> {
  const resetLink = `${appDomain}/reset-password?token=${token}`;
  
  try {
    const transport = getTransporter();
    const fromEmail = process.env.SMTP_FROM_EMAIL;
    const fromName = process.env.SMTP_FROM_NAME || 'EfficoreChat';
    
    console.log('Attempting to send password reset email:', {
      to: email,
      from: `${fromName} <${fromEmail}>`,
      link: resetLink.substring(0, 50) + '...'
    });
    
    const result = await transport.sendMail({
      from: `"${fromName}" <${fromEmail}>`,
      to: email,
      subject: 'Restablecer contraseña - EfficoreChat',
      html: getPasswordResetEmailHTML(name, resetLink, appDomain)
    });
    
    console.log(`Password reset email sent successfully to ${email}`, {
      messageId: result.messageId,
      response: result.response
    });
    return true;
  } catch (error: any) {
    console.error('Failed to send password reset email:', {
      to: email,
      errorCode: error.code,
      errorMessage: error.message,
      errorResponse: error.response,
      errorCommand: error.command,
      fullError: error.toString()
    });
    return false;
  }
}
