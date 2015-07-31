'use strict';

class tabaSubmenuDirective {
    menu ( ) {
        return function() {
            return {
                restrict : 'A',
                template : '<nav ng-if="showSubmenu" class="section menu"><ul><li ng-repeat="item in submenu"><a ng-href="{{item.url}}">{{item.name}}</a></li></ul></nav>',
                link : function ( scope, element, attrs ) {
                    scope.submenu = 'hola'
                }
            }
        }
    }
}

export {
    tabaSubmenuDirective
};