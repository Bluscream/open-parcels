const { createClient } = require('@libsql/client');
const client = createClient({ url: 'file:data.db' });
async function run() {
  try {
    await client.execute("ALTER TABLE parcels ADD COLUMN last_event_description TEXT");
    console.log('Added last_event_description to parcels.');
  } catch (e) {
    if (e.message.includes('duplicate column')) {
      console.log('Column already exists, skipping.');
    } else throw e;
  }
  client.close();
}
run().catch(console.error);
