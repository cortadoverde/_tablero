var events = require('events'),
       tcp = require('net');

function Client(){
    events.EventEmitter.call(this);

    this.isConnect = false;

    this.connect = function(port, host) {
        var self = this;

        this.port = port;

        this.host = host;

        this.socket = new tcp.Socket();

        this.socket.setKeepAlive(true);

        this.socket.connect(port, host, function(){
            self.isConnect = true;
            self.emit('ready');
        })

        this.socket.on('data', function(data){
            self.emit('data', data);
        })

        this.socket.on('close', function(){
            self.emit('disconnect');
        })

        this.socket.on('error', function(){
            self.isConnect = false;
            self.emit('error', arguments );
        })
    },

    this.restart = function() {
       this.connect(this.port, this.host);
    },

    this.disconnect = function() {
        this.socket.destroy();
        this.isConnect = false;
        this.emit('disconnect');
    }



}

Client.prototype.__proto__ = events.EventEmitter.prototype;

module.exports = new Client