'use strict';

class tabaCtrl {
    constructor( $scope, $rootScope, $timeout, $window, Flash) {
        $scope.app = $scope.tablero = $scope.msgs = {} ;
        $scope.semaforo = {};



        $scope.tablero.attemps         = 0;
        $scope.tablero.maxAttemps      = 2;
        $scope.tablero.ttAttemp        = 20 * 60 ;
        $scope.tablero.connecting      = false;
        $scope.tablero.errorConnection = false;
        $scope.tablero.connected       = false;

        $scope.semaforo.attemps         = 0;
        $scope.semaforo.maxAttemps      = 2;
        $scope.semaforo.ttAttemp        = 20 * 60 ;
        $scope.semaforo.connecting      = false;
        $scope.semaforo.errorConnection = false;
        $scope.semaforo.connected       = false;

        ipc.on('crono-status', function (status) {
            $scope.$apply( function(){                
                if( status == 'connect' ) {
                    $scope.tablero.connected = true;
                    $scope.tablero.connecting = false;
                    $scope.tablero.errorConnection = false;
                    $scope.$broadcast('crono-connect');
                } else {
                    $scope.tablero.connected = false;
                    $scope.$broadcast('crono-disconnect');
                }
            });
        })

        ipc.on('semaforo-status', function (status) {
            $scope.$apply( function(){                
                if( status == 'connect' ) {
                    $scope.semaforo.connected = true;
                    $scope.semaforo.connecting = false;
                    $scope.semaforo.errorConnection = false;
                    $scope.$broadcast('semaforo-connect');
                } else {
                    $scope.semaforo.connected = false;
                    $scope.$broadcast('semaforo-disconnect');
                }
            });
        })

        $scope.$on('semaforo-connect', function(){
             Flash.create('success', 'conexion exitosa', 'customAlert'); 
            //$scope.powerOn();
        })

        $scope.$on('crono-connect', function(){
             Flash.create('success', 'conexion exitosa', 'customAlert'); 
            //$scope.powerOn();
        })

        $scope.$on('semaforo-disconnect', function(){
             Flash.create('warning', 'Semaforo desconectado', 'customAlert'); 
            //$scope.powerOn();
        })

        $scope.$on('crono-disconnect', function(){
             Flash.create('warning', 'Tablero desconectado', 'customAlert'); 
            //$scope.powerOn();
        })

        ipc.on('crono-error', function ( _trace ) {
            $scope.tablero.connecting =  false;
            $scope.$apply( function(){
                $scope.tryConnect()
            })
        })

        ipc.on('semaforo-error', function ( _trace ) {
            $scope.tablero.connecting =  false;
            $scope.$apply( function(){
                $scope.tryConnectSem()
            })
        })


        $scope.tryConnect = function() {
           if( $scope.tablero.attemps < $scope.tablero.maxAttemps ) {
                $scope.tablero.attemps++;
                $scope.cronoConnect();
            } else {
                $scope.tablero.errorConnection = true;
            }
        }

        $scope.tryConnectSem = function() {
           if( $scope.semaforo.attemps < $scope.semaforo.maxAttemps ) {
                $scope.semaforo.attemps++;
                $scope.semConnect();
            } else {
                $scope.semaforo.errorConnection = true;
            }
        }

        $scope.resetAttemps = function( e ) {
            e.preventDefault();
            if( $scope.tablero.attemps == $scope.tablero.maxAttemps ) {
                $scope.tablero.attemps = 0;
                $scope.cronoConnect();
            }
        }

        $scope.connectTo = function( ip ) {
            $scope.tablero.ip = ip;            
        }

        $scope.cronoConnect = function() {
            $scope.tablero.connecting = true;
            $scope.tablero.errorConnection = false;
            $scope.tablero.ip = $rootScope.config.ip || '192.168.1.15';
            ipc.send('crono-connect', $scope.tablero.ip );
        }

        $scope.semConnect = function() {
            ipc.send('semaforo-connect', $rootScope.config.semaforo_ip || '192.168.1.30' );
        }

        $scope.sendCommand = function( command ) {
            console.log(command);
            ipc.send('crono-send', command);
        }

        $scope.powerOff = function() {
            ipc.send('crono-send', '012000000'); 
            ipc.send('crono-send', '000      ');
        }

        $scope.powerOn = function() {
            ipc.send('crono-send', 'A12000000');
        }

        $scope.disconnect = function() {
            //$scope.powerOff();
            ipc.send('crono-disconnect');
        }

        $scope.semDisconnect = function () {
            ipc.send('semaforo-disconnect');
        }
            

        $scope.switch = function() {
            if( $scope.tablero.connected ) 
                return $scope.disconnect();
            return $scope.cronoConnect();
        }

        $scope.switchSem = function() {
            if( $scope.semaforo.connected )
                return $scope.semDisconnect();
            return $scope.semConnect();
        }

        $scope.msgSuccess = function( data ) {
            Flash.create('success', data); 
            console.log(data);
        }
        
    }
}

export {
    tabaCtrl
};