require('dotenv').config();
const fs = require('fs');

// Read your service account JSON file
const serviceAccount = JSON.parse(
    fs.readFileSync('./path-to-your-service-account.json', 'utf8')
);

// The private key needs proper newline handling
const privateKey = serviceAccount.private_key;

console.log('Add this to your .env file:\n');
console.log('GOOGLE_SERVICE_ACCOUNT_EMAIL=' + serviceAccount.client_email);
console.log('\nGOOGLE_PRIVATE_KEY="' + privateKey + '"');
```

3. **On Render.com**, update the environment variable:
   - Go to your service → Environment
   - Edit `GOOGLE_PRIVATE_KEY`
   - **Important**: Paste the ENTIRE key including the `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines
   - Make sure it's wrapped in quotes
   - The key should look like this in the environment variable:
```
"-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDvrcPwBw/uJ0aO
...multiple lines...
-----END PRIVATE KEY-----"
