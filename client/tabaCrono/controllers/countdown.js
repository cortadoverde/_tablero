'use strict';

class countDownCtrl {
  constructor( $scope, $timeout ) {
    var timer;
    $scope.initTime = false;
    $scope.time = {
        hh : "00",
        mm : "00",
        ss : "00"
    }

    $scope.seconds = 0;
    
    var pad = function(i){
        var s = "" + i;
        return s.length == 1 ? "0" + s : s;
    }

    $scope.start = function() {
      $scope.stop();
      $scope.seconds = $scope._getStartSeconds();
      timer = setInterval($scope._decrement, 1000);
    }

    $scope.stop = function() {
      clearInterval(timer);
    }

    $scope._decrement = function() {
      if ($scope.seconds === 0) {
        $scope.$broadcast('countdown-stop');
        return;
      }
      $scope.seconds--;

      if ($scope.seconds === 0) {
        $scope.isRefreshing = true;
      }
      $scope.$apply();

      $scope.$broadcast('countdown-emit',[$scope.seconds]);
    }

    $scope._getStartSeconds = function() {
      var startDateTime = moment();
      var endDateTime = moment()
                       .add( parseInt($scope.time.hh), 'hours')
                       .add( parseInt($scope.time.mm), 'minutes')
                       .add( parseInt($scope.time.ss), 'seconds')


      var timeLeft = $scope.seconds = endDateTime.diff(startDateTime, 'seconds', true);
      return Math.floor (timeLeft);
    }

    $scope.$on('countdown-stop', function(){
      $scope.stop();
    })

    $scope.$on('countdown-emit', function( seconds ) {
        console.log($scope.seconds);
        var h = Math.floor( $scope.seconds / 3600 ) % 24 ;
        var m = Math.floor( $scope.seconds / 60 ) % 60;
        var s = $scope.seconds % 60;

        var str = ['A02', pad(h), pad(m), pad(s), "\r"].join('');
        console.log(str);
        $scope.sendCommand(str);
      
    })

    $scope.countDown = function()
    {
       var startDateTime = moment();
       var endDateTime = moment()
                        .add( parseInt($scope.time.hh), 'hours')
                        .add( parseInt($scope.time.mm), 'minutes')
                        .add( parseInt($scope.time.ss), 'seconds')


       var timeLeft = $scope.seconds = endDateTime.diff(startDateTime, 'seconds', true);


       var hours = Math.floor(moment.duration(timeLeft).asHours());

       endDateTime = endDateTime.subtract(hours, 'hours');
       timeLeft = endDateTime.diff(startDateTime, 'milliseconds', true);

       var minutes = Math.floor(moment.duration(timeLeft).asMinutes());

       endDateTime = endDateTime.subtract(minutes, 'minutes');
       timeLeft = endDateTime.diff(startDateTime, 'milliseconds', true);

       var seconds = Math.floor(moment.duration(timeLeft).asSeconds());



    }


  }
}

export {
    countDownCtrl
};
