'use strict';

var _arguments = arguments;
var app = require('app');
var BrowserWindow = require('browser-window');
var ipc = require('ipc');
var Tablero = require('./lib/tcp.client');
var statusTablero = false;
var Menu = require('menu');
var path = require('path');
var dialog = require('dialog');

require('crash-reporter').start();

var mainWindow = null;
var appIcon = null;

app.on('window-all-closed', function () {
    if (process.platform != 'darwin') {
        app.quit();
    }
});

app.on('ready', function () {
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600
    });

    var menu = Menu.buildFromTemplate([{
        label: 'Archivo',
        submenu: [{
            label: 'Cerrar',
            accelerator: 'Command+Q',
            click: function click() {
                mainWindow.destroy();
            }
        }]
    }, {
        label: 'Ver',
        submenu: [{
            label: 'Pantalla completa',
            accelerator: 'F11',
            click: function click() {
                mainWindow.setFullScreen(!mainWindow.isFullScreen());
            }
        }]
    }, {
        label: 'Ayuda',
        submenu: [{
            label: 'Acerca de',
            accelerator: 'F1',
            click: function click() {
                dialog.showMessageBox(mainWindow, {
                    type: 'info',
                    title: 'Taba crono v1.0',
                    buttons: ['aceptar'],
                    message: 'desarrollado por tabasoftware \r soporte@tabasoftware.com.ar'
                });
            }
        }]
    }]);

    //mainWindow.setMenu(menu);

    mainWindow.loadUrl('file://' + __dirname + '/../client/index.html');

    mainWindow.webContents.on('did-finish-load', function () {
        mainWindow.setTitle('.:Taba Crono:.');
    });

    mainWindow.on('closed', function () {
        mainWindow = null;
    });
});

/**
 * Eventos para el cronometro
 *   Namespace: crono
 *   Call: crono-{{action}}
 */
ipc.on('crono-check', function (_event, arg) {
    var resp = Tablero.isConnect ? 'connected' : 'disconnected';
    _event.returnValue = Tablero.isConnect;
    _event.sender.send('crono-check-repply', resp);
});

ipc.on('crono-connect', function (_event, ipConnection) {
    Tablero.connect(8899, ipConnection);
});

ipc.on('crono-disconnect', function (_event) {
    Tablero.disconnect();
});

ipc.on('crono-send', function (_event, _command) {
    if (Tablero.isConnect) {
        var command;
        command = _command.length < 9 ? _command + ' '.repeat(9 - _command.length) : _command;
        command = command.substr(0, 9) + '\r';
        Tablero.socket.write(command);
    } else {
        mainWindow.webContents.send('crono-error', 'no se puedo establecer la conexion');
    }
});

Tablero.on('error', function () {
    var d = _arguments;
    mainWindow.webContents.send('crono-error', d);
    console.error(d);
});

Tablero.on('ready', function () {
    mainWindow.webContents.send('crono-status', 'connect');
});

Tablero.on('disconnect', function () {
    mainWindow.webContents.send('crono-status', 'disconnect');
});