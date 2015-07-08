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
      alert('se termino el tiempo de espera');
    })

    $scope.$on('countdown-emit', function( seconds ) {
        console.log($scope.seconds);
        $scope.time.str = momment.duration($scope.seconds, 'seconds').format('h:mm:ss');
    })

    $scope.countDown = function()
    {
       var startDateTime = moment();
       var endDateTime = moment()
                        .add( parseInt($scope.time.hh), 'hours')
                        .add( parseInt($scope.time.mm), 'minutes')
                        .add( parseInt($scope.time.ss), 'seconds')


       var timeLeft = $scope.seconds = endDateTime.diff(startDateTime, 'seconds', true);

       /*
       var endDateTime = moment()
                        .add( parseInt($scope.time.hh), 'hours')
                        .add( parseInt($scope.time.mm), 'minutes')
                        .add( parseInt($scope.time.ss), 'seconds')

       var timeLeft = endDateTime.diff(startDateTime, 'seconds', true);
       */


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
