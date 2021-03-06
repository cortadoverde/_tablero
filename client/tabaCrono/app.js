import angular from 'angular';
import 'angular-route';
import 'angular-animate';
import 'sachinchoolur/angular-flash';

import moment from 'moment';

import { tabaSubmenuDirective } from './directives/taba/submenu';
import { textCtrl } from './controllers/text';
import { partidorCtrl } from './controllers/partidor';
import { marqueeCtrl } from './controllers/marquee';
import { cronoCtrl } from './controllers/crono';
import { countDownCtrl } from './controllers/countdown';
import { tabaCtrl } from './controllers/taba';
import { configCtrl } from './controllers/config';


var app = angular.module('TabaCrono', ['ngRoute','flash', 'ngAnimate']);

app.config( function ($routeProvider) {
    $routeProvider

        .when('/', {
            templateUrl : 'views/home.html',
            controller  : 'cronoCtrl'
        })

        .when('/countdown', {
            templateUrl : 'views/countdown.html',
            controller  : 'countDownCtrl'
        })

        .when('/marquesina', {
            templateUrl : 'views/marquesina.html',
            controller  : 'marqueeCtrl'
        })

        .when('/texto', {
            templateUrl : 'views/texto.html',
            controller  : 'textCtrl'
        })

        .when('/partidor', {
            templateUrl : 'views/partidor.html',
            controller  : 'partidorCtrl'
        })

        .when('/configuracion', {
            templateUrl : 'views/config.html',
            controller  : 'configCtrl'
        })

        .otherwise({
            redirectTo: '/'
        });
});

app.run( function ( $rootScope, $window ) {
    $rootScope._intervals = [];

    if( typeof $window.localStorage.config != 'undefined' ) {
        $rootScope.config = JSON.parse( $window.localStorage.config );

    }

    $rootScope.$on('$routeChangeSuccess', function ( newVal, oldVal ) {
        angular.forEach($rootScope._intervals, function(_interval){
            clearInterval(_interval);
        })
    })
});

app.controller('tabaCtrl', tabaCtrl);
app.controller('cronoCtrl', cronoCtrl );
app.controller('countDownCtrl', countDownCtrl );
app.controller('textCtrl', textCtrl );
app.controller('partidorCtrl', partidorCtrl );
app.controller('marqueeCtrl', marqueeCtrl );
app.controller('configCtrl', configCtrl );

app.directive('tabaSubmenu', function() {
    return {
        restrict : 'A',
        template : '<nav ng-if="showSubmenu"><ul><li>Menu para la seccion: <li ng-repeat="item in submenu"><a ng-href="{{item.url}}">{{item.name}}</a></li></ul></nav>'
    }
})

app.directive('tabaRemoveLoadingReady', function(){
    return {
        restrict : 'A',
        link : function( scope, element, attrs ) {
            element.removeClass('loading');
            element.removeClass('segment');
            element.removeClass('ui');
        }
    }
})
app.directive('tabaRemoveHiddenReady', function(){
    return {
        restrict : 'A',
        link : function( scope, element, attrs ) {
            element.removeClass('taba-hidden');
        }
    }
})

app.filter('tabaOnOf', function( val ) {
    if( ! val )
        return 'Conectar';
    return 'Desconectar';
})

app.filter('tabaOnOf', function() {
    return function( val ) {
        if( ! val )
            return 'Conectar';
        return 'Desconectar';
    }
})

app.filter('tabaOnOfClass', function() {
    return function( val ) {
        if( ! val )
            return 'green';
        return 'red';
    }
})


app.filter('uiGrid', function() {
    return function( column ) {
        var name = ['',
                'one','two','three','four','five','six','seven',
                'eight','nine', 'ten','eleven','twelve','thirteen',
                'fourteen','fifteen','sixteen'
            ];

        if( typeof name[column] !== 'undefined' )
            return name[column];
        return name[(name.length-1)];
    }
})


app.filter('HMMSS', ['$filter', function ($filter) {
        return function (input, decimals) {
            var sec_num = parseInt(input, 10),
                decimal = parseFloat(input) - sec_num,
                hours   = Math.floor(sec_num / 3600),
                minutes = Math.floor((sec_num - (hours * 3600)) / 60),
                seconds = sec_num - (hours * 3600) - (minutes * 60);

            if (hours   < 10) {hours   = "0"+hours;}
            if (minutes < 10) {minutes = "0"+minutes;}
            if (seconds < 10) {seconds = "0"+seconds;}
            var time    = hours+':'+minutes+':'+seconds;
            if (decimals > 0) {
                time += '.' + $filter('number')(decimal, decimals).substr(2);
            }
            return time;
        };
    }])

