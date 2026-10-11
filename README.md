# Nabeng Paystack MoMo Collection

A starter Ghana Mobile Money collection dashboard using HTML/CSS/JavaScript, Node.js/Express, Paystack, and Supabase.

## Included
- Responsive payment dashboard
- Mobile Money charge initiation through Paystack
- Supabase payment records with Row Level Security enabled
- Server-side Paystack transaction verification
- Paystack webhook signature verification
- Basic dashboard password gate
- Request rate limiting and security headers

## Requirements
- Node.js 18 or newer
- Supabase project
- Paystack account with Ghana Mobile Money enabled for the channels you intend to use

## Setup on Windows / VS Code
1. Extract the ZIP and open the `nabeng-paystack-momo` folder in VS Code.
2. Open the terminal in that folder and run:
   ```bash
   npm install
   ```
3. In Supabase, open **SQL Editor** and run `supabase-schema.sql`.
4. Copy `.env.example` to a new file named `.env`.
5. Fill in your Paystack **test** secret key, Supabase URL, Supabase service-role key, dashboard username, and a long unique dashboard password.
6. Start the app:
   ```bash
   npm start
   ```
7. Open `http://localhost:3000`. Your browser will ask for the dashboard username/password configured in `.env`.

## Paystack webhook
Set the webhook URL in the Paystack dashboard to:

`https://YOUR-DEPLOYED-DOMAIN/api/paystack-webhook`

For local webhook testing, use a secure HTTPS tunnel or a deployed test environment.

## Render deployment
- Create a new **Web Service** from your repository.
- Build command: `npm install`
- Start command: `npm start`
- Add the variables from `.env.example` in Render's Environment settings.
- Set `APP_ORIGIN` to your deployed HTTPS origin if you later use it for additional origin validation.
- Configure the Paystack webhook URL with your Render domain.

## Important safety notes
- Keep `.env` out of Git and never place the Paystack secret or Supabase service-role key in frontend JavaScript.
- Use test credentials first. Do not accept live payments until your Paystack account and Mobile Money channels are enabled and you've tested the complete flow.
- Basic Authentication is only a starter access gate. For a public multi-user dashboard, replace it with a proper session-based login system and role-based permissions.
- The example keeps the dashboard protected with Basic Auth, which means the browser may remember credentials. Use a unique password and HTTPS in production.
- The customer must approve the mobile-money prompt. An API response saying a request started is not proof of payment.
- Test a rejected prompt, a pending payment, a failed payment, a successful verified payment, invalid webhook signatures, and temporary Paystack/Supabase errors.
- Confirm the current provider codes and channel availability in your Paystack account and the official Paystack documentation before going live.

## Official references
- https://paystack.com/docs/payments/accept-payments/
- https://paystack.com/docs/payments/verify-payments/
- https://paystack.com/docs/payments/webhooks/
