'use strict';

class cronoCtrl {
    constructor( $scope, $window, $interval ) {
        console.log(moment);
        $scope.showSubmenu = true;
        $scope.crono = {
            automatico : true,
            intencidad : 1,
            command : {
                slot   : '      ',
                mode   : 1,
                light  : 'A',
                points : '2'
            },
            started : false,
            _interval : null,
            time : {
                hh : '00',
                mm : '00',
                ss : '00'
            }
        };

        $scope.$on('crono-connect', function(){
            $scope.$broadcast('crono-ligth')
        })

        var pad = function(i){
            var s = "" + i;
            return s.length == 1 ? "0" + s : s;
        }

        $scope.$watch('crono.automatico',function(n){
            if( n ) {
                $scope.crono.command.light = 'A';
            } else {
                $scope.crono.command.light = $scope.crono.intencidad;
            }
            $scope.$broadcast('crono-ligth')
        });

        $scope.$watch('crono.intencidad',function(n){
            if( ! $scope.crono.automatico )
                $scope.crono.command.light = n;
            $scope.$broadcast('crono-ligth')
        });

        $scope.$on('crono-ligth', function(){
            //$scope.sendCommand($scope.crono.command.light + '4       ');
        })

        $scope.iniciar = function() {
            $scope.crono.command.slot = [pad($scope.crono.time.hh), pad($scope.crono.time.mm), pad($scope.crono.time.ss)].join('');
            $scope.sendCommand([$scope.crono.command.light, 1, $scope.crono.command.points, $scope.crono.command.slot].join(''));
        }

    }
}

export {
    cronoCtrl
};
