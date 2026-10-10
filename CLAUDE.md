# Admin repository guidance

Parent instructions: `../../CLAUDE.md`.

- Current branch: `feat/whatsapp-ai-operations`.
- This is a static vanilla HTML/CSS/JavaScript portal deployed separately on Vercel.
- Do not deploy, push, or edit `main`.
- A signed-in Supabase user is not automatically an administrator. Authorization must use server-controlled roles and database policies.
- Do not add new direct browser writes for payments, confirmations, invoices, catalog prices, or AI/human takeover. Route sensitive operations through authenticated Worker APIs.
- Remove hidden login-time seed/repair mutations before relying on this portal for operational workflows.
- Never expose a Supabase secret/service key in browser code.
- Maintain the approved GHS 6,500 funeral fallback until the canonical catalog is the verified source.
- Validate JavaScript syntax and manually inspect affected screens after changes.
