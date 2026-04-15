# AlitogoPay Backend Deployment

This document describes how to host the `alitogopay/backend` service and the required environment configuration.

## Recommended GitHub setup

- Use the backend code stored in `alitogopay/backend`.
- If you are pushing to GitHub, create a repository containing the backend root.
- Example repo URL: `https://github.com/Paulias2006/Paul`.

## Required environment variables

Copy `./.env.production.example` to `./.env` and replace placeholders with your real values.

Minimum required values:
- `NODE_ENV=production`
- `MONGODB_URI` (MongoDB Atlas connection string)
- `JWT_SECRET`
- `JWT_REFRESH_SECRET`
- `PAYGATE_AUTH_TOKEN`
- `PAYGATE_WEBHOOK_SECRET`
- `FRONTEND_URL` (e.g. `https://weeshop.onrender.com`)
- `CORS_ORIGIN` (e.g. `https://weeshop.onrender.com`)
- `SELF_BASE_URL` (backend public URL)

## Hosting on Render

1. Create a new Web Service on Render.
2. Connect your GitHub repository.
3. Set the root directory to the backend folder if needed.
4. Set build command: `npm install`
5. Set start command: `npm start`
6. Set the environment variables from `.env.production.example`.
7. Use the `PORT` value from Render or leave it default; Render exposes `PORT` automatically.

## Example Render environment

- `NODE_ENV=production`
- `PORT=4001` (Render sets the port automatically)
- `MONGODB_URI=mongodb+srv://<DB_USER>:<DB_PASSWORD>@cluster0.kqn5p5f.mongodb.net/alitogopay?retryWrites=true&w=majority`
- `SELF_BASE_URL=https://alitogopay.onrender.com`
- `FRONTEND_URL=https://weeshop.onrender.com`
- `CORS_ORIGIN=https://weeshop.onrender.com,https://alitogopay.onrender.com`

## Weeshop integration notes

- For production, all Weeshop sync URLs must point to the live Weeshop backend.
- Replace local URLs such as `http://localhost:5000/api/paygate/weedelivred-sync` with `https://weeshop.onrender.com/api/paygate/weedelivred-sync`.
- Add both payment and payout sync URLs in the environment variables.

## Security notes

- Keep secrets out of GitHub. Do not commit `.env`.
- Use strong random values for `JWT_SECRET`, `JWT_REFRESH_SECRET`, `WEEDELIVRED_SYNC_SECRET`, and webhook secrets.
- Use `EMAIL_APP_PASSWORD` or `SENDGRID_API_KEY` for email sending instead of plain SMTP passwords when possible.

## Local development

Use the existing `.env.example` for local development, and keep the production example separate.
