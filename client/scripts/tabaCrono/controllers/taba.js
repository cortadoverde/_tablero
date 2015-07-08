'use strict';

class tabaCtrl {
    constructor( $scope, $rootScope, $timeout, $window, Flash) {
        $scope.app = $scope.tablero = $scope.msgs = {} ;

    

        $scope.tablero.attemps         = 0;
        $scope.tablero.maxAttemps      = 2;
        $scope.tablero.ttAttemp        = 20 * 60 ;
        $scope.tablero.connecting      = false;
        $scope.tablero.errorConnection = false;
        $scope.tablero.connected       = false;

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

        $scope.$on('crono-connect', function(){
             Flash.create('success', 'conexion exitosa', 'customAlert'); 
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

        $scope.tryConnect = function() {
            console.log($scope.tablero.attemps);
           if( $scope.tablero.attemps < $scope.tablero.maxAttemps ) {
                $scope.tablero.attemps++;
                console.log($scope.tablero.attemps);
                $scope.cronoConnect();
            } else {
                $scope.tablero.errorConnection = true;
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

        $scope.sendCommand = function( command ) {
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

        $scope.switch = function() {
            console.log($scope.tablero.connected);
            if( $scope.tablero.connected ) 
                return $scope.disconnect();
            return $scope.cronoConnect();
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