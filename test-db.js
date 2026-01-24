require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function testDatabase() {
    console.log('🔍 Testing Database Connection...\n');
    
    try {
        // Test connection
        const client = await pool.connect();
        console.log('✅ Database connected successfully!\n');
        
        // Check restaurants
        const restaurantsResult = await client.query('SELECT COUNT(*) FROM restaurants');
        console.log(`📊 Restaurants: ${restaurantsResult.rows[0].count}`);
        
        // Check menu items
        const menuResult = await client.query('SELECT COUNT(*) FROM menu_items');
        console.log(`📋 Menu Items: ${menuResult.rows[0].count}`);
        
        // Check orders
        const ordersResult = await client.query('SELECT COUNT(*) FROM orders');
        console.log(`🛒 Orders: ${ordersResult.rows[0].count}`);
        
        // Check bookings
        const bookingsResult = await client.query('SELECT COUNT(*) FROM table_bookings');
        console.log(`🪑 Bookings: ${bookingsResult.rows[0].count}`);
        
        // Display restaurants
        console.log('\n🏪 Available Restaurants:');
        const restaurants = await client.query('SELECT id, name, cuisine_type FROM restaurants ORDER BY id');
        restaurants.rows.forEach(r => {
            console.log(`   ${r.id}. ${r.name} - ${r.cuisine_type}`);
        });
        
        // Display menu items count per restaurant
        console.log('\n📋 Menu Items per Restaurant:');
        const menuStats = await client.query(`
            SELECT r.name, COUNT(m.id) as item_count 
            FROM restaurants r 
            LEFT JOIN menu_items m ON r.id = m.restaurant_id 
            GROUP BY r.name 
            ORDER BY r.name
        `);
        menuStats.rows.forEach(stat => {
            console.log(`   ${stat.name}: ${stat.item_count} items`);
        });
        
        client.release();
        console.log('\n✅ Database test completed successfully!');
        
    } catch (error) {
        console.error('❌ Database test failed:', error.message);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

testDatabase();