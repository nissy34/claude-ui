// Usage: npm run hash-password -- 'my password'
// Prints a value for CW_PASSWORD_HASH so the plain password never sits in a config file.
import { hashPassword } from './auth.js';

const pw = process.argv[2];
if (!pw) {
  console.error("Usage: npm run hash-password -- 'your password'");
  process.exit(1);
}
console.log(hashPassword(pw));
