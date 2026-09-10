// The API's entry point, server.ts, performs this ordering for the server
// process, but the CLI entry points under scripts/ never load it, and the
// backend architecture guide (§10) forbids moving it out of server.ts. This is
// its one sanctioned mirror for script processes, imported as the literal first
// statement of every script; it exports nothing — importing it is the API.
import dns from 'dns';
// This VPS has broken IPv6 egress — Node otherwise prefers AAAA records and
// outbound HTTPS (the Firebase certificate download, OpenRouter, USDA) hangs
// until timeout on fresh processes. Must run before any network module loads.
dns.setDefaultResultOrder('ipv4first');

import dotenv from 'dotenv';
// Scripts run through `npm run <script>` from the backend package root, so the
// default lookup resolves that directory's .env. Variables already present in
// the environment are never overwritten, so CI-injected values win.
dotenv.config();
