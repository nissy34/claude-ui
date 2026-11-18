// Stands in for a web browser (BROWSER, xdg-open, x-www-browser, www-browser) in the processes
// Claude UI starts: hands the URL to the UI server, which opens it in its sign-in browser.
const url = process.argv.slice(2).find((a) => /^https?:\/\//i.test(a));
if (!url || !process.env.CW_INTERNAL_URL) process.exit(1);
fetch(`${process.env.CW_INTERNAL_URL}/internal/open-url`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-cw-token': process.env.CW_INTERNAL_TOKEN || '' },
  body: JSON.stringify({ url, sid: process.env.CW_SESSION_ID || '' }),
}).then(
  (r) => process.exit(r.ok ? 0 : 1),
  () => process.exit(1)
);
