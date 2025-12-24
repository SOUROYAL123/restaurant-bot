const fs = require('fs');
const path = require('path');

class Logger {
    constructor() {
        this.logsDir = path.join(__dirname, '..', 'logs');
        
        if (!fs.existsSync(this.logsDir)) {
            fs.mkdirSync(this.logsDir, { recursive: true });
        }
    }
    
    _write(level, message, data = {}) {
        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            level,
            message,
            ...data
        };
        
        // Console output with colors
        const colors = {
            info: '\x1b[36m',
            success: '\x1b[32m',
            warning: '\x1b[33m',
            error: '\x1b[31m',
            reset: '\x1b[0m'
        };
        
        const color = colors[level] || colors.reset;
        console.log(`${color}[${timestamp}] [${level.toUpperCase()}]${colors.reset} ${message}`);
        
        if (Object.keys(data).length > 0) {
            console.log(JSON.stringify(data, null, 2));
        }
        
        // File output
        const logFile = path.join(
            this.logsDir, 
            `${new Date().toISOString().split('T')[0]}.log`
        );
        
        fs.appendFileSync(
            logFile, 
            JSON.stringify(logEntry) + '\n'
        );
    }
    
    info(message, data) {
        this._write('info', message, data);
    }
    
    success(message, data) {
        this._write('success', message, data);
    }
    
    warning(message, data) {
        this._write('warning', message, data);
    }
    
    error(message, error) {
        this._write('error', message, {
            error: error.message,
            stack: error.stack
        });
    }
    
    appointment(action, appointmentId, data = {}) {
        this._write('info', `Appointment ${action}`, {
            appointmentId,
            ...data
        });
    }
}

module.exports = new Logger();
