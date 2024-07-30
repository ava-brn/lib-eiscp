'use strict';

const net = require('net');
const dgram = require('dgram');
const util = require('util');
const events = require('events');
const eiscpCommands = require('./eiscp-commands.json');

const COMMANDS = eiscpCommands.commands;
const COMMAND_MAPPINGS = eiscpCommands.command_mappings;
const VALUE_MAPPINGS = eiscpCommands.value_mappings;
const MODELSETS = eiscpCommands.modelsets;

const DEFAULT_CONFIG = {
    port: 60128,
    reconnect: true,
    reconnectDelay: 5,
    modelsets: [],
    sendDelay: 500,
    verifyCommands: true
};

module.exports = class Client extends events.EventEmitter {
    static debugger = new events.EventEmitter();

    /**
     * Discovers eISCP providers using a UDP broadcast message.
     * @param {Object} options
     * @param {number} options.devices    - stop listening after this amount of devices have answered (default: 1)
     * @param {number} options.timeout    - time in seconds to wait for devices to respond (default: 10)
     * @param {string} options.address    - broadcast address to send magic packet to (default: 255.255.255.255)
     * @param {number} options.port       - receiver port should always be 60128 this is just available if you need it
     * @returns Promise<Service[]>
     */
    static async discover ({ devices = 1, timeout = 10, address = '255.255.255.255', port = 60128 } = {}) {
        return new Promise((resolve, reject) => {
            const socket = dgram.createSocket('udp4');
            const result = [];

            const timeoutRef = setTimeout(() => {
                socket.close();
                resolve(result);
            }, timeout * 1000);

            socket.on('error', (err) => {
                socket.close();
                reject(util.format("Server error on %s:%s - %s", address, port, err));
            });
            
            socket.on('message', (packet, remoteInfo) => {
                const message = messageFromBuffer(packet);
                const command = message.slice(0, 3);

                if (command !== 'ECN')  {
                    Client.debugger.emit('debug', util.format("Expected discovery message, but received data from %s:%s - %j", remoteInfo.address, remoteInfo.port, message));
                    return;
                }

                const [model, portString, areaCode, macString] = message.slice(3).split('/');
                result.push({
                    model,
                    host: remoteInfo.address,
                    port: Number(portString),
                    mac: macString.slice(0, 12), // There're lots of null chars after the MAC so we slice them off
                    areaCode,
                });

                Client.debugger.emit('debug', "Received discovery packet from", { host: remoteInfo.address, port: remoteInfo.port, model });

                if (result.length >= devices) {
                    clearTimeout(timeoutRef);
                    socket.close();
                    resolve(result);
                }
            });

            socket.on('listening', function () {
                Client.debugger.emit('debug', util.format("Sent broadcast discovery packet to %s:%s", address, port));

                socket.setBroadcast(true);

                let onkyo_buffer = bufferFromMessage('!xECNQSTN');
                socket.send(onkyo_buffer, 0, onkyo_buffer.length, port, address);
                
                let pioneer_buffer = bufferFromMessage('!pECNQSTN');
                socket.send(pioneer_buffer, 0, pioneer_buffer.length, port, address);
            });
            
            socket.bind(0);
        });
    };

    constructor({ host, port, model, reconnect, reconnectDelay, verifyCommands } = {}) {
        super();
        this.host = host;
        this.port = port || DEFAULT_CONFIG.port;
        this.model = model || DEFAULT_CONFIG.model;
        this.reconnect = reconnect != null ? reconnect : DEFAULT_CONFIG.reconnect;
        this.reconnectDelaySecs = reconnectDelay ?? DEFAULT_CONFIG.reconnectDelay;
        this.verifyCommands = verifyCommands != null ? verifyCommands : DEFAULT_CONFIG.verifyCommands;
        this.modelSets = new Set();
        this.isConnected = false;
    }

    async connect() {
        if (!this.host) {
            throw new Error('Host required to connect!');
        }
        
        // If host is configured but no model is set - we send a discover directly to this receiver
        if (!this.model) {
            throw new Error('Model required to connect!');
        }
        
        const connectionTarget = {
            host: this.host,
            port: this.port
        };
    
        this.computeModelSets(); // to verity commands (if set to true)
    
        this.emit('debug', util.format("Connecting to %s:%s (model: %s)", this.host, this.port, this.model));
        return new Promise((resolve, reject) => {
            
            // Reconnect if we have previously connected
            if (this.socket) {
                if (!this.socket.connecting && !this.isConnected) {
                    this.socket.once('error', (error) => reject(error));
                    this.socket.connect(connectionTarget, () => resolve());
                }

                return;
            }
        
            // Connecting the first time
            this.socket = net.connect(connectionTarget, () => resolve());
            this.socket.once('error', (error) => reject(error));
        
            this.socket
                .on('connect', () => {
                    this.isConnected = true;
                    this.emit('connect', this.host, this.port, this.model);
                })
                .on('close', () => {
                    this.isConnected = false;
                    this.emit('debug', util.format("Disconnected from %s:%s", this.host, this.port));
                    this.emit('close', this.host, this.port);
        
                    if (this.reconnect) {
                        setTimeout(async () => await this.connect(), this.reconnectDelaySecs * 1000);
                    }
                })
                .on('error', (err) => {
                    this.emit('error', err);
                    this.socket.destroy();
                })
                .on('data', (data) => {
                    const iscpMessage = messageFromBuffer(data);
                    const result = iscpMessageToCommand(iscpMessage);
        
                    result.iscpMessage = iscpMessage;
                    result.host  = this.host;
                    result.port  = this.port;
                    result.model = this.model;
        
                    this.emit('debug', util.format("Received data from %s:%s", this.host, this.port), result);
                    this.emit('message', result);
        
                    // If the command is supported we emit it as well
                    if (result.command) {
                        if (Array.isArray(result.command)) {
                            result.command.forEach((cmd) => this.emit(cmd, result.argument));
                        } else {
                            this.emit(result.command, result.argument);
                        }
                    }
                });
        });
    };

    /**
     * Send a low level command like PWR01
     * callback only tells you that the command was sent but not that it succsessfully did what you asked
    */
    async raw(data) {
        return new Promise((resolve, reject) => {
            if (!data) {
                return reject('No data provided.');
            }

            if (!this.isConnected) {
                this.emit('error', "Not connected, can't send data", { data });
                return reject('Send command, while not connected');
            }

            this.emit('debug', util.format("Sent command to %s:%s - %s", this.host, this.port, data));
            this.socket.write(bufferFromMessage(data), (err) => err ? reject(err) : resolve());
        });
    };

    /** Send a high level command like system-power=query */
    async command(data) {
        return await this.raw(this.commandToIscpMessage(data));
    };

    close() {
        if (this.isConnected && this.socket) {
            this.socket.destroy();
        }
    }

    getCommands(zone) {
        return Object.keys(COMMAND_MAPPINGS[zone]);
    };
    
    /**
      Returns all command values in given zone and command
    */
    getCommandValues(command) {
        const parts = command.split('.');
        const zone = parts.length !== 2 ? 'main' : parts.shift();
        command = parts.shift();

        return Object.keys(VALUE_MAPPINGS[zone][COMMAND_MAPPINGS[zone][command]]);
    };

    commandToIscpMessage(command, args, zone) {
        let prefix, value;
    
        // If parts are not explicitly given - parse the command
        if (args == null && zone == null) {
            const parts = parseCommand(command);
            if (!parts) {
                // Error parsing command
                this.emit('error', util.format("Command and arguments provided could not be parsed (%s)", command));
                return;
            }
            zone = parts.zone;
            command = parts.command;
            args = parts.value;
        }
    
        this.emit('debug', 'Command to ISCP', {zone, command, args});
    
        // Find the command in our database, resolve to internal eISCP command
    
        if (typeof COMMANDS[zone] === 'undefined') {
            this.emit('error', util.format("Zone %s does not exist in command file", zone));
            return;
        }
    
        if (typeof COMMAND_MAPPINGS[zone][command] === 'undefined') {
            this.emit('error', util.format("Command %s does not exist in zone %s", command, zone));
            return;
        }
    
        prefix = COMMAND_MAPPINGS[zone][command];
    
        if (typeof VALUE_MAPPINGS[zone][prefix][args] === 'undefined') {
    
            if (typeof VALUE_MAPPINGS[zone][prefix].INTRANGES !== 'undefined' && /^[0-9\-+]+$/.test(args)) {
                // This command is part of a integer range
                
                value = this.rangeValue({ zone, prefix, args });
            } else {
                // Not yet supported command
                this.emit('error', util.format("Argument %s does not exist in command %s", args, command));
                return;
            }
    
        } else {
            // Check if the commands modelset is in the receviers modelsets
            if (!this.verifyCommands || isInModelSets(VALUE_MAPPINGS[zone][prefix][args].models)) {
                value = VALUE_MAPPINGS[zone][prefix][args].value;
            } else {
                this.emit('error', util.format("Command %s in zone %s is not supported on this model.", command, zone));
                return;
            }
        }
    
        this.emit('debug', util.format('Command to ISCP message (raw command) "%s"', prefix + value));
    
        return prefix + value;
    }
    
    /**
        Compute modelsets for this model (so commands which are possible on this model are allowed)
        Note that this is not an exact match, model only has to be part of the modelname
    */
    computeModelSets() {
        Object.keys(MODELSETS).forEach((set) => {
            MODELSETS[set].forEach((models) => {
                if (models.indexOf(this.model) !== -1) {
                    DEFAULT_CONFIG.modelsets.push(set);
                }
            });
        });

        Object.keys(MODELSETS).forEach((set) => {
            if (MODELSETS[set].some((model) => model.includes(this.model))) {
                this.modelSets.add(set);
            }
        });

        // Compare old and new approach
        this.emit('debug', 'Comparing model sets', DEFAULT_CONFIG.modelsets, this.modelSets);
    }
    
    rangeValue({ zone, prefix, args, }) {
        let value;
        const intRanges = VALUE_MAPPINGS[zone][prefix].INTRANGES;
        for (let i = 0; i < intRanges.length; i += 1) {
            this.emit('debug', 'Is in range', this.modelSets, intRanges[i].models);
            if (this.modelSets.has(intRanges[i].models) && isNumberInRange(args, intRanges[i].range)) {
                // args is an integer and is in the available range for this command
                value = args;
            }
        }

        if (typeof value === 'undefined' && this.verifyCommands) {
            throw new Error(util.format("Command %s=%s is not available on this model", command, args));
        } else {
            value = args;
        }

        if (value.indexOf('+') !== -1){ // For range -12 to + 12
            // Convert decimal number to hexadecimal since receiver doesn't understand decimal
            value = (+value).toString(16).toUpperCase();
            value = '+' + value;
        } else {
            // Convert decimal number to hexadecimal since receiver doesn't understand decimal
            value = (+value).toString(16).toUpperCase();
            // Pad value if it is not 2 digits
            value = (value.length < 2) ? '0' + value : value;
        }

        return value;
    }
}

/**
  Wraps an ISCP message in an eISCP packet for communicating over Ethernet.
  Type is device type where 1 is receiver and x is for the discovery broadcast
  @param {string} iscpMessage Message in the format `[!t]cccpp`
    where `t` is the unit type (`'1'` | `'x'`), `ccc` is the command and `pp` is the parameter.
  @returns {Buffer} Complete eISCP packet as a buffer ready to be sent
*/
function bufferFromMessage(iscpMessage) {
    const startChar = '!';
    const receiverDestinationUnitType = '1';
    const endChar = '\n'; // CR | LF | CRLF

    if (iscpMessage.charAt(0) !== startChar) {
        iscpMessage = startChar + receiverDestinationUnitType + iscpMessage;
    }

    const eiscpData = Buffer.from(iscpMessage + endChar);
    
    const eiscpHeader = Buffer.from([
        0x49, 0x53, 0x43, 0x50, // magic number 'ISCP'
        0x00, 0x00, 0x00, 0x10, // header size = 16 bytes
        0x00, 0x00, 0x00, 0x00, // data size, set below
        0x01, 0x00, 0x00, 0x00, // version (1), reserved (3)
    ]);

    eiscpHeader.writeUInt32BE(eiscpData.length, 8);
    
    return Buffer.concat([eiscpHeader, eiscpData]);
}

/**
  Exracts message from eISCP packet
  Strip first 18 bytes and last 3 since that's only the header and end characters
  @param {Buffer} packet eISCP packet 
  @returns {string} iscpMessage
*/
function messageFromBuffer(packet) {
    // Header size 16 + startChar 1 + unitType 1 = 18 bytes
    // End = [EOF][CR][LF] = 3 bytes
    return packet.toString('ascii', 18, packet.length - 3);
}

/** Transform a low-level ISCP message to a high-level command */
function iscpMessageToCommand(iscpMessage) {
    let command = iscpMessage.slice(0, 3);
    let value = iscpMessage.slice(3);
    let result = {};

    Object.keys(COMMANDS).forEach((zone) => {
        if (COMMANDS[zone][command] == null) { return; }

        let zone_cmd = COMMANDS[zone][command];

        result.command = zone_cmd.name;
        result.zone = zone;

        if (zone_cmd.values[value] != null) {
            result.argument = zone_cmd.values[value].name;
        } else if (VALUE_MAPPINGS[zone][command].INTRANGES != null && /^[0-9a-fA-F]+$/.test(value)) {
            // It's a range so we need to convert args from hex to decimal
            result.argument = parseInt(value, 16);
        }
    });

    return result;
}

/** Splits by space, dot, equals and colon and normalizes command into 3 parts: { zone, command, value } */
function parseCommand(cmd) {
    const parts = cmd.toLowerCase()
        .split(/[\s\.=:]/)
        .filter((item) => !!item);

    if (parts.length < 2 || parts.length > 3) { return null; }
    if (parts.length === 2) { parts.unshift("main"); }

    return {
        zone: parts[0],
        command: parts[1],
        value: parts[2]
    };
}

/**
 * Returns true if the number is within the given range (inclusive).
 * @param {string} number 
 * @param {string} range Comma separated number range, inclusive
 * @returns 
 */
function isNumberInRange(number, range) {
    const parts = range.split(',');
    const numVal = parseInt(number, 10);
    return parts.length === 2
        && numVal >= parseInt(parts[0], 10)
        && numVal <= parseInt(parts[1], 10);
}
