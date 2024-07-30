'use strict';

const net = require('net');
const dgram = require('dgram');
const util = require('util');
const async = require('async');
const events = require('events');
const eiscp_commands = require('./eiscp-commands.json');

const COMMANDS = eiscp_commands.commands;
const COMMAND_MAPPINGS = eiscp_commands.command_mappings;
const VALUE_MAPPINGS = eiscp_commands.value_mappings;
const MODELSETS = eiscp_commands.modelsets;

let self, eiscp, send_queue;
let config = {
    port: 60128,
    reconnect: true,
    reconnect_sleep: 5,
    modelsets: [],
    send_delay: 500,
    verify_commands: true
};

module.exports = self = new events.EventEmitter();

self.v2 = class Client extends events.EventEmitter {
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
                reject(util.format("ERROR (server_error) Server error on %s:%s - %s", address, port, err));
            });
            
            socket.on('message', (packet, remoteInfo) => {
                const message = messageFromBuffer(packet);
                const command = message.slice(0, 3);

                if (command !== 'ECN')  {
                    self.emit('debug', util.format("DEBUG (received_data) Expected discovery message, but received data from %s:%s - %j", remoteInfo.address, remoteInfo.port, message));
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

                self.emit('debug', util.format("DEBUG (received_discovery) Received discovery packet from %s:%s (%j)", remoteInfo.address, remoteInfo.port, result));

                if (result.length >= devices) {
                    clearTimeout(timeoutRef);
                    socket.close();
                    resolve(result);
                }
            });

            socket.on('listening', function () {
                self.emit('debug', util.format("Sent broadcast discovery packet to %s:%s", address, port));

                socket.setBroadcast(true);

                let onkyo_buffer = bufferFromMessage('!xECNQSTN');
                socket.send(onkyo_buffer, 0, onkyo_buffer.length, port, address);
                
                let pioneer_buffer = bufferFromMessage('!pECNQSTN');
                socket.send(pioneer_buffer, 0, pioneer_buffer.length, port, address);
            });
            
            socket.bind(0);
        });
    };

    constructor({ host, port, model, reconnect, reconnect_sleep, verify_commands } = {}) {
        super();
        this.host = host;
        this.port = port || config.port;
        this.model = model || config.model;
        this.reconnect = reconnect != null ? reconnect : config.reconnect;
        this.reconnect_sleep = reconnect_sleep ?? config.reconnect_sleep;
        this.verify_commands = verify_commands != null ? verify_commands : config.verify_commands;
        this.modelSets = new Set();
        this.is_connected = false;
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
    
        self.emit('debug', util.format("INFO (connecting) Connecting to %s:%s (model: %s)", this.host, this.port, this.model));
        return new Promise((resolve, reject) => {
            
            // Reconnect if we have previously connected
            if (this.socket) {
                console.log(this.socket.readyState);

                if (!this.socket.connecting && !this.is_connected) {
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
                    this.is_connected = true;
                    this.emit('connect', this.host, this.port, this.model);
                })
                .on('close', () => {
                    this.is_connected = false;
                    this.emit('debug', util.format("INFO (disconnected) Disconnected from %s:%s", this.host, this.port));
                    this.emit('close', this.host, this.port);
        
                    if (this.reconnect) {
                        setTimeout(async () => await this.connect(), this.reconnect_sleep * 1000);
                    }
                })
                .on('error', (err) => {
                    this.emit('error', err);
                    this.socket.destroy();
                })
                .on('data', (data) => {
                    const iscpMessage = messageFromBuffer(data);
                    const result = iscpMessageToCommand(iscpMessage);
        
                    result.iscp_command = iscpMessage;
                    result.host  = this.host;
                    result.port  = this.port;
                    result.model = this.model;
        
                    this.emit('debug', util.format("DEBUG (received_data) Received data from %s:%s - %j", this.host, this.port, result));
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
     Send a low level command like PWR01
    callback only tells you that the command was sent but not that it succsessfully did what you asked
    */
    async raw(data) {
        return new Promise((resolve, reject) => {
            if (!data) {
                return reject('No data provided.');
            }

            if (!this.is_connected) {
                self.emit('error', util.format("ERROR (send_not_connected) Not connected, can't send data: %j", data));
                return reject('Send command, while not connected');
            }

            this.emit('debug', util.format("DEBUG (sent_command) Sent command to %s:%s - %s", this.host, this.port, data));
            this.socket.write(bufferFromMessage(data), (err) => err ? reject(err) : resolve());
        });
    };

    /** Send a high level command like system-power=query */
    async command(data) {
        return await this.raw(this.commandToIscpMessage(data));
    };

    close() {
        if (this.is_connected && this.socket) {
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
        let prefix, value, i;
    
        // If parts are not explicitly given - parse the command
        if (args == null && zone == null) {
            const parts = parseCommand(command);
            if (!parts) {
                // Error parsing command
                this.emit('error', util.format("ERROR (cmd_parse_error) Command and arguments provided could not be parsed (%s)", command));
                return;
            }
            zone = parts.zone;
            command = parts.command;
            args = parts.value;
        }
    
        self.emit('debug', util.format('DEBUG (command_to_iscp) Zone: %s | Command: %s | Argument: %s', zone, command, args));
    
        // Find the command in our database, resolve to internal eISCP command
    
        if (typeof COMMANDS[zone] === 'undefined') {
            this.emit('error', util.format("ERROR (zone_not_exist) Zone %s does not exist in command file", zone));
            return;
        }
    
        if (typeof COMMAND_MAPPINGS[zone][command] === 'undefined') {
            this.emit('error', util.format("ERROR (cmd_not_exist) Command %s does not exist in zone %s", command, zone));
            return;
        }
    
        prefix = COMMAND_MAPPINGS[zone][command];
    
        if (typeof VALUE_MAPPINGS[zone][prefix][args] === 'undefined') {
    
            if (typeof VALUE_MAPPINGS[zone][prefix].INTRANGES !== 'undefined' && /^[0-9\-+]+$/.test(args)) {
                // This command is part of a integer range
                
    
            } else {
                // Not yet supported command
                this.emit('error', util.format("ERROR (arg_not_exist) Argument %s does not exist in command %s", args, command));
                return;
            }
    
        } else {
            // Check if the commands modelset is in the receviers modelsets
            if (!this.verify_commands || in_modelsets(VALUE_MAPPINGS[zone][prefix][args].models)) {
                value = VALUE_MAPPINGS[zone][prefix][args].value;
            } else {
                self.emit('error', util.format("ERROR (cmd_not_supported) Command %s in zone %s is not supported on this model.", command, zone));
                return;
            }
        }
    
        self.emit('debug', util.format('DEBUG (command_to_iscp) raw command "%s"', prefix + value));
    
        return prefix + value;
    }
    
    /**
        Compute modelsets for this model (so commands which are possible on this model are allowed)
        Note that this is not an exact match, model only has to be part of the modelname
    */
    computeModelSets() {
        Object.keys(MODELSETS).forEach((set) => {
            MODELSETS[set].forEach((models) => {
                if (models.indexOf(config.model) !== -1) {
                    config.modelsets.push(set);
                }
            });
        });

        Object.keys(MODELSETS).forEach((set) => {
            if (MODELSETS[set].some((model) => model.includes(this.model))) {
                this.modelSets.add(set);
            }
        });

        // Compare old and new approach
        console.log(config.modelsets, this.modelSets);
    }
}

function rangeValue({ zone, prefix, args, }) {
    const intRanges = VALUE_MAPPINGS[zone][prefix].INTRANGES;
    for (let i = 0; i < intRanges.length; i += 1) {
        if (in_modelsets(intRanges[i].models) && in_intrange(args, intRanges[i].range)) {
            // args is an integer and is in the available range for this command
            value = args;
        }
    }

    if (typeof value === 'undefined' && config.verify_commands) {
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
}

self.is_connected = false;

function in_modelsets(set) {
    // returns true if set is in modelsets false otherwise
    return (config.modelsets.indexOf(set) !== -1);
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

// TODO: This function is starting to get very big, it should be split up into smaller parts and oranized better
/** Transform high-level command to a low-level ISCP message */
function commandToIscpMessage(command, args, zone) {
    let prefix, value, i, len;

    // If parts are not explicitly given - parse the command
    if (args == null && zone == null) {
		const parts = parseCommand(command);
		if (!parts) {
			// Error parsing command
			self.emit('error', util.format("ERROR (cmd_parse_error) Command and arguments provided could not be parsed (%s)", command));
			return;
		}
		zone = parts.zone;
		command = parts.command;
		args = parts.value;
    }

    self.emit('debug', util.format('DEBUG (command_to_iscp) Zone: %s | Command: %s | Argument: %s', zone, command, args));

    // Find the command in our database, resolve to internal eISCP command

    if (typeof COMMANDS[zone] === 'undefined') {
        self.emit('error', util.format("ERROR (zone_not_exist) Zone %s does not exist in command file", zone));
        return;
    }

    if (typeof COMMAND_MAPPINGS[zone][command] === 'undefined') {
        self.emit('error', util.format("ERROR (cmd_not_exist) Command %s does not exist in zone %s", command, zone));
        return;
    }

    prefix = COMMAND_MAPPINGS[zone][command];

    if (typeof VALUE_MAPPINGS[zone][prefix][args] === 'undefined') {

        if (typeof VALUE_MAPPINGS[zone][prefix].INTRANGES !== 'undefined' && /^[0-9\-+]+$/.test(args)) {
            // This command is part of a integer range
            const intRanges = VALUE_MAPPINGS[zone][prefix].INTRANGES;
            for (i = 0; i < intRanges.length; i += 1) {
                if (in_modelsets(intRanges[i].models) && in_intrange(args, intRanges[i].range)) {
                    // args is an integer and is in the available range for this command
                    value = args;
                }
            }

            if (typeof value === 'undefined' && config.verify_commands) {
                self.emit('error', util.format("ERROR (arg_not_in_range) Command %s=%s is not available on this model", command, args));
                return;
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

        } else {
            // Not yet supported command
            self.emit('error', util.format("ERROR (arg_not_exist) Argument %s does not exist in command %s", args, command));
            return;
        }

    } else {
        // Check if the commands modelset is in the receviers modelsets
        if (!config.verify_commands || in_modelsets(VALUE_MAPPINGS[zone][prefix][args].models)) {
            value = VALUE_MAPPINGS[zone][prefix][args].value;
        } else {
            self.emit('error', util.format("ERROR (cmd_not_supported) Command %s in zone %s is not supported on this model.", command, zone));
            return;
        }
    }

    self.emit('debug', util.format('DEBUG (command_to_iscp) raw command "%s"', prefix + value));

    return prefix + value;
}

function in_intrange(number, range) {
    let parts = range.split(',');
    number = parseInt(number, 10);
    return (parts.length === 2 && number >= parseInt(parts[0], 10) && number <= parseInt(parts[1], 10));
}

/**
  discover([options, ] callback)
  Sends broadcast and waits for response callback called when number of devices or timeout reached
  option.devices    - stop listening after this amount of devices have answered (default: 1)
  option.timeout    - time in seconds to wait for devices to respond (default: 10)
  option.address    - broadcast address to send magic packet to (default: 255.255.255.255)
  option.port       - receiver port should always be 60128 this is just available if you need it
*/
self.discover = function () {
    let callback, timeout_timer,
        options = {},
        result = [],
        client = dgram.createSocket('udp4'),
        argv = Array.prototype.slice.call(arguments),
        argc = argv.length;

    if (argc === 1 && typeof argv[0] === 'function') {
        callback = argv[0];
    } else if (argc === 2 && typeof argv[1] === 'function') {
        options = argv[0];
        callback = argv[1];
    } else {
        return;
    }

    options.devices = options.devices || 1;
    options.timeout = options.timeout || 10;
    options.address = options.address || '255.255.255.255';
    options.port = options.port || 60128;

    function close() {
        client.close();
        callback(false, result);
    }

    client
        .on('error', function (err) {
            self.emit('error', util.format("ERROR (server_error) Server error on %s:%s - %s", options.address, options.port, err));
            client.close();
            callback(err, null);
        })
        .on('message', function (packet, rinfo) {
            let message = messageFromBuffer(packet),
                command = message.slice(0, 3),
                data;
            if (command === 'ECN') {
                data = message.slice(3).split('/');
                result.push({
                    host:     rinfo.address,
                    port:     data[1],
                    model:    data[0],
                    mac:      data[3].slice(0, 12), // There's lots of null chars after MAC so we slice them off
                    areacode: data[2]
                });
                
                self.emit('debug', util.format("DEBUG (received_discovery) Received discovery packet from %s:%s (%j)", rinfo.address, rinfo.port, result));
                if (result.length >= options.devices) {
                    clearTimeout(timeout_timer);
                    close();
                }
            } else {
                self.emit('debug', util.format("DEBUG (received_data) Recevied data from %s:%s - %j", rinfo.address, rinfo.port, message));
            }
        })
        .on('listening', function () {
            client.setBroadcast(true);
            let onkyo_buffer = bufferFromMessage('!xECNQSTN');
            let pioneer_buffer = bufferFromMessage('!pECNQSTN');

            self.emit('debug', util.format("DEBUG (sent_discovery) Sent broadcast discovery packet to %s:%s", options.address, options.port));
            client.send(onkyo_buffer, 0, onkyo_buffer.length, options.port, options.address);
            client.send(pioneer_buffer, 0, pioneer_buffer.length, options.port, options.address);
            
            timeout_timer = setTimeout(close, options.timeout * 1000);
        })
        .bind(0);
};

/**
  No options required if you only have one receiver on your network. We will find it and connect to it!
  options.host            - Hostname/IP
  options.port            - Port (default: 60128)
  options.send_delay      - Delay in milliseconds between each command sent to receiver (default: 500)
  options.model           - Should be discovered automatically but if you want to override it you can
  options.reconnect       - Try to reconnect if connection is lost (default: false)
  options.reconnect_sleep - Time in seconds to sleep between reconnection attempts (default: 5)
  options.verify_commands - Whether the reject commands not found for the current model
*/
self.connect = function (options = {}) {
	config.host = options.host || config.host;
	config.port = options.port || config.port;
	config.model = options.model || config.model;
	config.reconnect = (options.reconnect === undefined) ? config.reconnect : options.reconnect;
	config.reconnect_sleep = options.reconnect_sleep || config.reconnect_sleep;
	config.verify_commands = (options.verify_commands === undefined) ? config.verify_commands : options.verify_commands;

    const connection_properties = {
        host: config.host,
        port: config.port
    };

    // If no host is configured - we connect to the first device to answer
    if (typeof config.host === 'undefined' || config.host === '') {
        self.discover(function (err, hosts) {
            if (!err && hosts && hosts.length > 0) {
                self.connect(hosts[0]);
            }
            return;
        });
        return;
    }

    // If host is configured but no model is set - we send a discover directly to this receiver
    if (typeof config.model === 'undefined' || config.model === '') {
        self.discover({address: config.host}, function (err, hosts) {
            if (!err && hosts && hosts.length > 0) {
                self.connect(hosts[0]);
            }
            return;
        });
        return;
    }

    /*
	  Compute modelsets for this model (so commands which are possible on this model are allowed)
      Note that this is not an exact match, model only has to be part of the modelname
    */
    Object.keys(MODELSETS).forEach(function (set) {
        MODELSETS[set].forEach(function (models) {
            if (models.indexOf(config.model) !== -1) {
                config.modelsets.push(set);
            }
        });
    });

    self.emit('debug', util.format("INFO (connecting) Connecting to %s:%s (model: %s)", config.host, config.port, config.model));

	// Reconnect if we have previously connected
    if (typeof eiscp !== 'undefined') {
		eiscp.connect(connection_properties);
		return;
    }

	// Connecting the first time
	eiscp = net.connect(connection_properties);

	eiscp
        .on('connect', function () {
            self.is_connected = true;
            self.emit('debug', util.format("INFO (connected) Connected to %s:%s (model: %s)", config.host, config.port, config.model));
            self.emit('connect', config.host, config.port, config.model);
        })
        .on('close', function () {
            self.is_connected = false;
            self.emit('debug', util.format("INFO (disconnected) Disconnected from %s:%s", config.host, config.port));
            self.emit('close', config.host, config.port);

            if (config.reconnect) {
                setTimeout(self.connect, config.reconnect_sleep * 1000);
            }
        })
        .on('error', function (err) {
            self.emit('error', util.format("ERROR (server_error) Server error on %s:%s - %s", config.host, config.port, err));
            eiscp.destroy();
        })
        .on('data', function (data) {
            let iscp_message = messageFromBuffer(data);
            let result = iscpMessageToCommand(iscp_message);

            result.iscp_command = iscp_message;
            result.host  = config.host;
            result.port  = config.port;
            result.model = config.model;

            self.emit('debug', util.format("DEBUG (received_data) Received data from %s:%s - %j", config.host, config.port, result));
            self.emit('data', result);

            // If the command is supported we emit it as well
            if (typeof result.command !== 'undefined') {
                if (Array.isArray(result.command)) {
                    result.command.forEach(function (cmd) {
                        self.emit(cmd, result.argument);
                    });
                } else {
                    self.emit(result.command, result.argument);
                }
            }
        });
};

self.close = self.disconnect = function () {
    if (self.is_connected) {
        eiscp.destroy();
    }
};

/**
  Syncronous queue which sends commands to device
  callback(bool error, string error_message)
*/
send_queue = async.queue(function (data, callback) {
    if (self.is_connected) {

        self.emit('debug', util.format("DEBUG (sent_command) Sent command to %s:%s - %s", config.host, config.port, data));

        eiscp.write(bufferFromMessage(data));

        setTimeout(callback, config.send_delay, false);
        return;
    }

    self.emit('error', util.format("ERROR (send_not_connected) Not connected, can't send data: %j", data));
    callback('Send command, while not connected', null);

}, 1);

/**
  Send a low level command like PWR01
  callback only tells you that the command was sent but not that it succsessfully did what you asked
*/
self.raw = function (data, callback) {
    if (typeof data !== 'undefined' && data !== '') {
        send_queue.push(data, function (err) {
            if (typeof callback === 'function') {
                callback(err, null);
            }
        });
    } else if (typeof callback === 'function') {
        callback(true, 'No data provided.');
    }
};

/**
  Send a high level command like system-power=query
  callback only tells you that the command was sent but not that it succsessfully did what you asked
*/
self.command = function (data, callback) {
    self.raw(commandToIscpMessage(data), callback);
};

/**
  Returns all commands in given zone
*/
self.get_commands = function (zone, callback) {
    let result = [];
    async.each(Object.keys(COMMAND_MAPPINGS[zone]), function (cmd, cb) {
        result.push(cmd);
        cb();
    }, function (err) {
        callback(err, result);
    });
};

/**
  Returns all command values in given zone and command
*/
self.get_command = function (command, callback) {
    let zone;
    let result = [];
    let parts = command.split('.');

    if (parts.length !== 2) {
        zone = 'main';
        command = parts[0];
    } else {
        zone = parts[0];
        command = parts[1];
    }

    async.each(Object.keys(VALUE_MAPPINGS[zone][COMMAND_MAPPINGS[zone][command]]), function (val, cb) {
        result.push(val);
        cb();
    }, function (err) {
        callback(err, result);
    });
};
