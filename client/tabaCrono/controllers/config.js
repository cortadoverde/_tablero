'use strict';

class configCtrl {
    constructor( $scope, $rootScope, $window ) {
        $scope.data = {};
        
        if( typeof $rootScope.config !== 'undefined' )
            $scope.data = $rootScope.config;


        $scope.save = function() {
            $rootScope.config = $scope.data;
            $window.localStorage.config = JSON.stringify($scope.data);
        }
    }
}

export {
    configCtrl
};