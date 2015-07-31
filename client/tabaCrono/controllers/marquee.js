'use strict';

class marqueeCtrl {
    constructor( $scope, $window, $interval, $rootScope ) {
        $scope.crono = {
            marquesina : {
                velocidad : 300,
                texto : ''
            },
            command : {
                slot   : '      ',
                mode   : 0,
                light  : 'A',
                points : '0'
            },
            _interval : null
        };


        $scope.$on('crono-ligth', function(){           
            //$scope.sendCommand($scope.crono.command.light + '4       ');
        })

        $scope.submit = function() {

            $scope.stop();
            $scope.crono.marquesina.run = true;

            var strlen = $scope.crono.marquesina.texto.length;
            var current = 0;
            var marquee = ' '.repeat(5) + $scope.crono.marquesina.texto.toUpperCase() + ' '.repeat(10) + ' '.repeat(5)

            var interval =  setInterval(function(){
              $scope.$apply(function () {
                
                $scope.crono.command.slot =  marquee.substr(current,6);

                $scope.sendCommand(
                    [
                        $scope.crono.command.light, 
                        $scope.crono.command.mode, 
                        $scope.crono.command.points, 
                        $scope.crono.command.slot
                    ].join('')
                );

                if( current + 1 == marquee.length - 6 ) {
                    current = 0;
                } else {
                    current++;
                }
              })
            }, $scope.crono.marquesina.velocidad );

            $scope.crono._interval = interval; 

        } 

        $scope.stop = function() {
            clearInterval($scope.crono._interval);
            $scope.crono.marquesina.run = false;
        }
       
    }
}

export {
    marqueeCtrl
};