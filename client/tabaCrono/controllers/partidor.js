'use strict';

class partidorCtrl {
    constructor( $scope, $window, $interval ) {
        
        var pad = function( t ) {
            return t < 100 ? '0' + t : t;
        }

        $scope.partidor = {
            participantes : 3,
            promedio : 60,
            preparacion: 20,
            inicio: 60,
            list : [],
            timer:0,
            interval : null,
            init : false,
            current : 0,
            inTimeout : false,
            rest: 0,
            showRest: false
        }   

        ipc.on('semaforo-response', function ( _trace ) {
            

            if( ! $scope.partidor.init ) {
                $scope.sendCommand(['A', 1, 2, '000000'].join(''));
                $scope.startCrono();
                $scope.partidor.init = true;
            } 

            setTimeout(function(){

                if( $scope.partidor.list.length > $scope.partidor.current+1 ) {

                    var proximo = $scope.partidor.list[$scope.partidor.current+1].start;

                    var diff = proximo - $scope.partidor.timer;

                    if( diff < $scope.partidor.preparacion ) {
                        while( diff < $scope.partidor.preparacion ) {
                            $scope.partidor.list.forEach(function(elm){

                                if( elm.id >= $scope.partidor.current+1 ) {
                                    $scope.partidor.list[elm.id].start = elm.start + 60;
                                }
                            });

                            proximo = $scope.partidor.list[$scope.partidor.current+1].start;

                            diff = proximo - $scope.partidor.timer;
                        } // end while
                   
                    }
                    
                    $scope.partidor.inTimeout = true;

                }

                $scope.$apply();

                
            }, 1000 * 10 )
        })


        $scope.startCrono = function() {
            $scope.partidor.interval = setInterval(function(){
                
                $scope.partidor.timer++;

                if( $scope.partidor.list.length > $scope.partidor.current+1 ) {
                    var proximo = $scope.partidor.list[$scope.partidor.current+1].start;
                    
                    var diff = proximo - $scope.partidor.timer;
                    var rest = $scope.partidor.rest = $scope.partidor.list[$scope.partidor.current].start - $scope.partidor.timer;
                   
                    if( rest == 0 ) {
                        $scope.partidor.showRest = false;
                    }  

                    if( rest > 0  ) {
                        $scope.partidor.showRest = true;
                    }

                    console.log($scope.partidor.timer, proximo, diff, $scope.partidor.current+1, $scope.partidor.inTimeout);

                   
                    if( $scope.partidor.inTimeout == true  && diff <= 60 && diff > $scope.partidor.preparacion ) {
                        $scope.sendToSemaforo('1' + pad(diff) + "\n" );
                        $scope.partidor.current++;
                        $scope.partidor.inTimeout = false;
                    }
                }                

                $scope.$apply();

            }, 1000);
        }

        $scope.createPartida = function( ) 
        {
            $scope.partidor.list = [];
           var total = parseInt($scope.partidor.participantes);
            for (var i=0; i<total; i++)
              $scope.partidor.list.push({
                 id : i,
                 start : ( i > 0 ) ? i * $scope.partidor.promedio : 0 
              });
        }



        $scope.sendToSemaforo = function( value ) 
        {
            console.log('Envia a semaforo:' + value);
            ipc.send('semaforo-send', value );
        }
      

        $scope.iniciar = function() {
           
            var tt = $scope.partidor.inicio < 100 ? '0' + $scope.partidor.inicio : $scope.partidor.inicio;
            $scope.sendCommand(['A', 0, 2, '000000'].join(''));
            $scope.sendToSemaforo('1' + tt + "\n" );
            
        } 

       
    }
}

export {
    partidorCtrl
};