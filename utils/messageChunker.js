// utils/messageChunker.js

/**
 * Split long messages into chunks under WhatsApp's 1600 character limit
 * Preserves formatting and tries to break at natural boundaries
 */
function chunkMessage(message, maxLength = 1500) {
    // Use 1500 to leave safety margin
    if (message.length <= maxLength) {
        return [message];
    }

    const chunks = [];
    let currentChunk = '';
    const lines = message.split('\n');

    for (const line of lines) {
        // If single line exceeds limit, split it
        if (line.length > maxLength) {
            if (currentChunk) {
                chunks.push(currentChunk.trim());
                currentChunk = '';
            }
            
            // Split long line at word boundaries
            const words = line.split(' ');
            let tempLine = '';
            
            for (const word of words) {
                if ((tempLine + word).length > maxLength) {
                    chunks.push(tempLine.trim());
                    tempLine = word + ' ';
                } else {
                    tempLine += word + ' ';
                }
            }
            
            if (tempLine) {
                currentChunk = tempLine;
            }
            continue;
        }

        // Check if adding this line exceeds limit
        if ((currentChunk + '\n' + line).length > maxLength) {
            chunks.push(currentChunk.trim());
            currentChunk = line + '\n';
        } else {
            currentChunk += (currentChunk ? '\n' : '') + line;
        }
    }

    if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
    }

    return chunks;
}

/**
 * Send long message in multiple parts with delay
 */
async function sendLongMessage(client, to, message, delayMs = 1000) {
    const chunks = chunkMessage(message);
    
    console.log(`Sending message in ${chunks.length} chunk(s)`);
    
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const prefix = chunks.length > 1 ? `[${i + 1}/${chunks.length}]\n\n` : '';
        
        await client.messages.create({
            from: process.env.TWILIO_WHATSAPP_NUMBER,
            to: to,
            body: prefix + chunk
        });
        
        // Add delay between messages to avoid rate limiting
        if (i < chunks.length - 1) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
    
    return chunks.length;
}

/**
 * Smart chunking for lists (clinics, menus, etc.)
 */
function chunkList(items, header, footer, maxLength = 1500) {
    const chunks = [];
    let currentChunk = header + '\n\n';
    const footerLength = footer ? footer.length + 2 : 0;
    
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const itemText = typeof item === 'string' ? item : formatItem(item);
        
        // Check if adding this item would exceed limit
        if ((currentChunk + itemText + footerLength).length > maxLength) {
            // Save current chunk
            chunks.push(currentChunk.trim());
            
            // Start new chunk with header
            currentChunk = header + ` (cont'd)\n\n` + itemText + '\n';
        } else {
            currentChunk += itemText + '\n';
        }
    }
    
    // Add last chunk with footer
    if (footer) {
        currentChunk += '\n' + footer;
    }
    chunks.push(currentChunk.trim());
    
    return chunks;
}

function formatItem(item) {
    if (typeof item === 'string') return item;
    
    // Format clinic/doctor item
    let text = '';
    if (item.name) text += `📍 ${item.name}\n`;
    if (item.doctor) text += `👨‍⚕️ Dr. ${item.doctor}\n`;
    if (item.specialty) text += `🏥 ${item.specialty}\n`;
    if (item.phone) text += `📞 ${item.phone}\n`;
    if (item.whatsapp) text += `💬 ${item.whatsapp}\n`;
    if (item.address) text += `📌 ${item.address}\n`;
    
    return text;
}

module.exports = {
    chunkMessage,
    sendLongMessage,
    chunkList,
    formatItem
};
