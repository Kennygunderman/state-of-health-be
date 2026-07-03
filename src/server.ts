import dns from 'dns';
// This VPS has broken IPv6 egress — Node otherwise prefers AAAA records and
// outbound HTTPS (Firebase cert fetch, OpenRouter, USDA) hangs until timeout
// on fresh processes. Must run before any network module is loaded.
dns.setDefaultResultOrder('ipv4first');

import dotenv from 'dotenv';
dotenv.config();

import app from './app';

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
