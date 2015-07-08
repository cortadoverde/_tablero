let app = require('app');
let BrowserWindow = require('browser-window');
let ipc  = require('ipc');
let Tablero = require('./lib/tcp.client');
let statusTablero = false;
let Menu = require('menu');
let path = require('path');
let dialog = require('dialog');

require('crash-reporter').start();

var mainWindow = null;
var appIcon = null;

app.on('window-all-closed', () => {
    if (process.platform != 'darwin') {
        app.quit();
    }
});

app.on('ready', () => {
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600
    });

    var menu = Menu.buildFromTemplate([
        {
            label : 'Archivo',
            submenu : [
                {
                    label : 'Cerrar',
                    accelerator: 'Command+Q',
                    click: () => {
                        mainWindow.destroy();
                    }
                }
            ]
        },
        {
            label : 'Ver',
            submenu : [
                {
                    label : 'Pantalla completa',
                    accelerator : 'F11',
                    click: () => {
                        mainWindow.setFullScreen( !mainWindow.isFullScreen() );
                    }
                }
            ]
        },
        {
            label : 'Ayuda',
            submenu : [
                {
                    label : 'Acerca de',
                    accelerator : 'F1',
                    click: () => {
                       dialog.showMessageBox(mainWindow,{
                            type: 'info',
                            title: 'Taba crono v1.0',
                            buttons:['aceptar'],
                            message: 'desarrollado por tabasoftware \r soporte@tabasoftware.com.ar'
                       })
                    }
                }
            ]
        }
    ]);



    //mainWindow.setMenu(menu);

    mainWindow.loadUrl('file://' + __dirname + '/../client/index.html');

    mainWindow.webContents.on('did-finish-load',() =>{
        mainWindow.setTitle('.:Taba Crono:.');
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

});


/**
 * Eventos para el cronometro
 *   Namespace: crono
 *   Call: crono-{{action}}
 */
ipc.on('crono-check', (_event, arg) => {
    let resp = Tablero.isConnect ? 'connected' : 'disconnected';
   _event.returnValue = Tablero.isConnect;
   _event.sender.send('crono-check-repply', resp );
})

ipc.on('crono-connect', (_event, ipConnection) => {
    Tablero.connect(8899, ipConnection);
})

ipc.on('crono-disconnect', (_event) => {
    Tablero.disconnect();
})

ipc.on('crono-send', (_event, _command) => {
    if( Tablero.isConnect ) {
        var command;
        command = ( ( _command.length < 9 ) ? _command + ' '.repeat( 9 - _command.length ) : _command );
        command = command.substr(0,9) + '\r';
        Tablero.socket.write( command );
    } else {
        mainWindow.webContents.send('crono-error', 'no se puedo establecer la conexion');
    }

})

Tablero.on('error', () => {
    var d = arguments;
    mainWindow.webContents.send('crono-error', d);
    console.error(d);
})

Tablero.on('ready', () => {
    mainWindow.webContents.send('crono-status', 'connect');
})

Tablero.on('disconnect', () => {
    mainWindow.webContents.send('crono-status', 'disconnect');
})
