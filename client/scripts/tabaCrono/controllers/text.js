'use strict';

class textCtrl {
    constructor( $scope, $window, $interval ) {
        $scope.crono = {
            text : '',
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
            
            $scope.crono.command.slot = $scope.crono.text.toUpperCase().substr(0,6); 
          
            $scope.sendCommand(
                [
                    $scope.crono.command.light, 
                    $scope.crono.command.mode, 
                    $scope.crono.command.points, 
                    $scope.crono.command.slot
                ].join('')
            );

        } 

       
    }
}

export {
    textCtrl
};