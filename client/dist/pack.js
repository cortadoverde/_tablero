(function(global) {

  var defined = {};

  // indexOf polyfill for IE8
  var indexOf = Array.prototype.indexOf || function(item) {
    for (var i = 0, l = this.length; i < l; i++)
      if (this[i] === item)
        return i;
    return -1;
  }

  function dedupe(deps) {
    var newDeps = [];
    for (var i = 0, l = deps.length; i < l; i++)
      if (indexOf.call(newDeps, deps[i]) == -1)
        newDeps.push(deps[i])
    return newDeps;
  }

  function register(name, deps, declare, execute) {
    if (typeof name != 'string')
      throw "System.register provided no module name";

    var entry;

    // dynamic
    if (typeof declare == 'boolean') {
      entry = {
        declarative: false,
        deps: deps,
        execute: execute,
        executingRequire: declare
      };
    }
    else {
      // ES6 declarative
      entry = {
        declarative: true,
        deps: deps,
        declare: declare
      };
    }

    entry.name = name;

    // we never overwrite an existing define
    if (!(name in defined))
      defined[name] = entry; 

    entry.deps = dedupe(entry.deps);

    // we have to normalize dependencies
    // (assume dependencies are normalized for now)
    // entry.normalizedDeps = entry.deps.map(normalize);
    entry.normalizedDeps = entry.deps;
  }

  function buildGroups(entry, groups) {
    groups[entry.groupIndex] = groups[entry.groupIndex] || [];

    if (indexOf.call(groups[entry.groupIndex], entry) != -1)
      return;

    groups[entry.groupIndex].push(entry);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];

      // not in the registry means already linked / ES6
      if (!depEntry || depEntry.evaluated)
        continue;

      // now we know the entry is in our unlinked linkage group
      var depGroupIndex = entry.groupIndex + (depEntry.declarative != entry.declarative);

      // the group index of an entry is always the maximum
      if (depEntry.groupIndex === undefined || depEntry.groupIndex < depGroupIndex) {

        // if already in a group, remove from the old group
        if (depEntry.groupIndex !== undefined) {
          groups[depEntry.groupIndex].splice(indexOf.call(groups[depEntry.groupIndex], depEntry), 1);

          // if the old group is empty, then we have a mixed depndency cycle
          if (groups[depEntry.groupIndex].length == 0)
            throw new TypeError("Mixed dependency cycle detected");
        }

        depEntry.groupIndex = depGroupIndex;
      }

      buildGroups(depEntry, groups);
    }
  }

  function link(name) {
    var startEntry = defined[name];

    startEntry.groupIndex = 0;

    var groups = [];

    buildGroups(startEntry, groups);

    var curGroupDeclarative = !!startEntry.declarative == groups.length % 2;
    for (var i = groups.length - 1; i >= 0; i--) {
      var group = groups[i];
      for (var j = 0; j < group.length; j++) {
        var entry = group[j];

        // link each group
        if (curGroupDeclarative)
          linkDeclarativeModule(entry);
        else
          linkDynamicModule(entry);
      }
      curGroupDeclarative = !curGroupDeclarative; 
    }
  }

  // module binding records
  var moduleRecords = {};
  function getOrCreateModuleRecord(name) {
    return moduleRecords[name] || (moduleRecords[name] = {
      name: name,
      dependencies: [],
      exports: {}, // start from an empty module and extend
      importers: []
    })
  }

  function linkDeclarativeModule(entry) {
    // only link if already not already started linking (stops at circular)
    if (entry.module)
      return;

    var module = entry.module = getOrCreateModuleRecord(entry.name);
    var exports = entry.module.exports;

    var declaration = entry.declare.call(global, function(name, value) {
      module.locked = true;
      exports[name] = value;

      for (var i = 0, l = module.importers.length; i < l; i++) {
        var importerModule = module.importers[i];
        if (!importerModule.locked) {
          var importerIndex = indexOf.call(importerModule.dependencies, module);
          importerModule.setters[importerIndex](exports);
        }
      }

      module.locked = false;
      return value;
    });

    module.setters = declaration.setters;
    module.execute = declaration.execute;

    if (!module.setters || !module.execute)
      throw new TypeError("Invalid System.register form for " + entry.name);

    // now link all the module dependencies
    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];
      var depModule = moduleRecords[depName];

      // work out how to set depExports based on scenarios...
      var depExports;

      if (depModule) {
        depExports = depModule.exports;
      }
      else if (depEntry && !depEntry.declarative) {
        if (depEntry.module.exports && depEntry.module.exports.__esModule)
          depExports = depEntry.module.exports;
        else
          depExports = { 'default': depEntry.module.exports, __useDefault: true };
      }
      // in the module registry
      else if (!depEntry) {
        depExports = load(depName);
      }
      // we have an entry -> link
      else {
        linkDeclarativeModule(depEntry);
        depModule = depEntry.module;
        depExports = depModule.exports;
      }

      // only declarative modules have dynamic bindings
      if (depModule && depModule.importers) {
        depModule.importers.push(module);
        module.dependencies.push(depModule);
      }
      else
        module.dependencies.push(null);

      // run the setter for this dependency
      if (module.setters[i])
        module.setters[i](depExports);
    }
  }

  // An analog to loader.get covering execution of all three layers (real declarative, simulated declarative, simulated dynamic)
  function getModule(name) {
    var exports;
    var entry = defined[name];

    if (!entry) {
      exports = load(name);
      if (!exports)
        throw new Error("Unable to load dependency " + name + ".");
    }

    else {
      if (entry.declarative)
        ensureEvaluated(name, []);

      else if (!entry.evaluated)
        linkDynamicModule(entry);

      exports = entry.module.exports;
    }

    if ((!entry || entry.declarative) && exports && exports.__useDefault)
      return exports['default'];

    return exports;
  }

  function linkDynamicModule(entry) {
    if (entry.module)
      return;

    var exports = {};

    var module = entry.module = { exports: exports, id: entry.name };

    // AMD requires execute the tree first
    if (!entry.executingRequire) {
      for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
        var depName = entry.normalizedDeps[i];
        var depEntry = defined[depName];
        if (depEntry)
          linkDynamicModule(depEntry);
      }
    }

    // now execute
    entry.evaluated = true;
    var output = entry.execute.call(global, function(name) {
      for (var i = 0, l = entry.deps.length; i < l; i++) {
        if (entry.deps[i] != name)
          continue;
        return getModule(entry.normalizedDeps[i]);
      }
      throw new TypeError('Module ' + name + ' not declared as a dependency.');
    }, exports, module);

    if (output)
      module.exports = output;
  }

  /*
   * Given a module, and the list of modules for this current branch,
   *  ensure that each of the dependencies of this module is evaluated
   *  (unless one is a circular dependency already in the list of seen
   *  modules, in which case we execute it)
   *
   * Then we evaluate the module itself depth-first left to right 
   * execution to match ES6 modules
   */
  function ensureEvaluated(moduleName, seen) {
    var entry = defined[moduleName];

    // if already seen, that means it's an already-evaluated non circular dependency
    if (!entry || entry.evaluated || !entry.declarative)
      return;

    // this only applies to declarative modules which late-execute

    seen.push(moduleName);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      if (indexOf.call(seen, depName) == -1) {
        if (!defined[depName])
          load(depName);
        else
          ensureEvaluated(depName, seen);
      }
    }

    if (entry.evaluated)
      return;

    entry.evaluated = true;
    entry.module.execute.call(global);
  }

  // magical execution function
  var modules = {};
  function load(name) {
    if (modules[name])
      return modules[name];

    var entry = defined[name];

    // first we check if this module has already been defined in the registry
    if (!entry)
      throw "Module " + name + " not present.";

    // recursively ensure that the module and all its 
    // dependencies are linked (with dependency group handling)
    link(name);

    // now handle dependency execution in correct order
    ensureEvaluated(name, []);

    // remove from the registry
    defined[name] = undefined;

    var module = entry.module.exports;

    if (!module || !entry.declarative && module.__esModule !== true)
      module = { 'default': module, __useDefault: true };

    // return the defined module object
    return modules[name] = module;
  };

  return function(mains, declare) {

    var System;
    var System = {
      register: register, 
      get: load, 
      set: function(name, module) {
        modules[name] = module; 
      },
      newModule: function(module) {
        return module;
      },
      global: global 
    };
    System.set('@empty', {});

    declare(System);

    for (var i = 0; i < mains.length; i++)
      load(mains[i]);
  }

})(typeof window != 'undefined' ? window : global)
/* (['mainModule'], function(System) {
  System.register(...);
}); */

(['tabaCrono/app'], function(System) {

System.register("github:angular/bower-angular@1.4.1/angular", [], false, function(__require, __exports, __module) {
  System.get("@@global-helpers").prepareGlobal(__module.id, []);
  (function() {
    "format global";
    "exports angular";
    (function(window, document, undefined) {
      'use strict';
      function minErr(module, ErrorConstructor) {
        ErrorConstructor = ErrorConstructor || Error;
        return function() {
          var SKIP_INDEXES = 2;
          var templateArgs = arguments,
              code = templateArgs[0],
              message = '[' + (module ? module + ':' : '') + code + '] ',
              template = templateArgs[1],
              paramPrefix,
              i;
          message += template.replace(/\{\d+\}/g, function(match) {
            var index = +match.slice(1, -1),
                shiftedIndex = index + SKIP_INDEXES;
            if (shiftedIndex < templateArgs.length) {
              return toDebugString(templateArgs[shiftedIndex]);
            }
            return match;
          });
          message += '\nhttp://errors.angularjs.org/1.4.1/' + (module ? module + '/' : '') + code;
          for (i = SKIP_INDEXES, paramPrefix = '?'; i < templateArgs.length; i++, paramPrefix = '&') {
            message += paramPrefix + 'p' + (i - SKIP_INDEXES) + '=' + encodeURIComponent(toDebugString(templateArgs[i]));
          }
          return new ErrorConstructor(message);
        };
      }
      var REGEX_STRING_REGEXP = /^\/(.+)\/([a-z]*)$/;
      var VALIDITY_STATE_PROPERTY = 'validity';
      var lowercase = function(string) {
        return isString(string) ? string.toLowerCase() : string;
      };
      var hasOwnProperty = Object.prototype.hasOwnProperty;
      var uppercase = function(string) {
        return isString(string) ? string.toUpperCase() : string;
      };
      var manualLowercase = function(s) {
        return isString(s) ? s.replace(/[A-Z]/g, function(ch) {
          return String.fromCharCode(ch.charCodeAt(0) | 32);
        }) : s;
      };
      var manualUppercase = function(s) {
        return isString(s) ? s.replace(/[a-z]/g, function(ch) {
          return String.fromCharCode(ch.charCodeAt(0) & ~32);
        }) : s;
      };
      if ('i' !== 'I'.toLowerCase()) {
        lowercase = manualLowercase;
        uppercase = manualUppercase;
      }
      var msie,
          jqLite,
          jQuery,
          slice = [].slice,
          splice = [].splice,
          push = [].push,
          toString = Object.prototype.toString,
          getPrototypeOf = Object.getPrototypeOf,
          ngMinErr = minErr('ng'),
          angular = window.angular || (window.angular = {}),
          angularModule,
          uid = 0;
      msie = document.documentMode;
      function isArrayLike(obj) {
        if (obj == null || isWindow(obj)) {
          return false;
        }
        var length = "length" in Object(obj) && obj.length;
        if (obj.nodeType === NODE_TYPE_ELEMENT && length) {
          return true;
        }
        return isString(obj) || isArray(obj) || length === 0 || typeof length === 'number' && length > 0 && (length - 1) in obj;
      }
      function forEach(obj, iterator, context) {
        var key,
            length;
        if (obj) {
          if (isFunction(obj)) {
            for (key in obj) {
              if (key != 'prototype' && key != 'length' && key != 'name' && (!obj.hasOwnProperty || obj.hasOwnProperty(key))) {
                iterator.call(context, obj[key], key, obj);
              }
            }
          } else if (isArray(obj) || isArrayLike(obj)) {
            var isPrimitive = typeof obj !== 'object';
            for (key = 0, length = obj.length; key < length; key++) {
              if (isPrimitive || key in obj) {
                iterator.call(context, obj[key], key, obj);
              }
            }
          } else if (obj.forEach && obj.forEach !== forEach) {
            obj.forEach(iterator, context, obj);
          } else if (isBlankObject(obj)) {
            for (key in obj) {
              iterator.call(context, obj[key], key, obj);
            }
          } else if (typeof obj.hasOwnProperty === 'function') {
            for (key in obj) {
              if (obj.hasOwnProperty(key)) {
                iterator.call(context, obj[key], key, obj);
              }
            }
          } else {
            for (key in obj) {
              if (hasOwnProperty.call(obj, key)) {
                iterator.call(context, obj[key], key, obj);
              }
            }
          }
        }
        return obj;
      }
      function forEachSorted(obj, iterator, context) {
        var keys = Object.keys(obj).sort();
        for (var i = 0; i < keys.length; i++) {
          iterator.call(context, obj[keys[i]], keys[i]);
        }
        return keys;
      }
      function reverseParams(iteratorFn) {
        return function(value, key) {
          iteratorFn(key, value);
        };
      }
      function nextUid() {
        return ++uid;
      }
      function setHashKey(obj, h) {
        if (h) {
          obj.$$hashKey = h;
        } else {
          delete obj.$$hashKey;
        }
      }
      function baseExtend(dst, objs, deep) {
        var h = dst.$$hashKey;
        for (var i = 0,
            ii = objs.length; i < ii; ++i) {
          var obj = objs[i];
          if (!isObject(obj) && !isFunction(obj))
            continue;
          var keys = Object.keys(obj);
          for (var j = 0,
              jj = keys.length; j < jj; j++) {
            var key = keys[j];
            var src = obj[key];
            if (deep && isObject(src)) {
              if (!isObject(dst[key]))
                dst[key] = isArray(src) ? [] : {};
              baseExtend(dst[key], [src], true);
            } else {
              dst[key] = src;
            }
          }
        }
        setHashKey(dst, h);
        return dst;
      }
      function extend(dst) {
        return baseExtend(dst, slice.call(arguments, 1), false);
      }
      function merge(dst) {
        return baseExtend(dst, slice.call(arguments, 1), true);
      }
      function toInt(str) {
        return parseInt(str, 10);
      }
      function inherit(parent, extra) {
        return extend(Object.create(parent), extra);
      }
      function noop() {}
      noop.$inject = [];
      function identity($) {
        return $;
      }
      identity.$inject = [];
      function valueFn(value) {
        return function() {
          return value;
        };
      }
      function isUndefined(value) {
        return typeof value === 'undefined';
      }
      function isDefined(value) {
        return typeof value !== 'undefined';
      }
      function isObject(value) {
        return value !== null && typeof value === 'object';
      }
      function isBlankObject(value) {
        return value !== null && typeof value === 'object' && !getPrototypeOf(value);
      }
      function isString(value) {
        return typeof value === 'string';
      }
      function isNumber(value) {
        return typeof value === 'number';
      }
      function isDate(value) {
        return toString.call(value) === '[object Date]';
      }
      var isArray = Array.isArray;
      function isFunction(value) {
        return typeof value === 'function';
      }
      function isRegExp(value) {
        return toString.call(value) === '[object RegExp]';
      }
      function isWindow(obj) {
        return obj && obj.window === obj;
      }
      function isScope(obj) {
        return obj && obj.$evalAsync && obj.$watch;
      }
      function isFile(obj) {
        return toString.call(obj) === '[object File]';
      }
      function isFormData(obj) {
        return toString.call(obj) === '[object FormData]';
      }
      function isBlob(obj) {
        return toString.call(obj) === '[object Blob]';
      }
      function isBoolean(value) {
        return typeof value === 'boolean';
      }
      function isPromiseLike(obj) {
        return obj && isFunction(obj.then);
      }
      var TYPED_ARRAY_REGEXP = /^\[object (Uint8(Clamped)?)|(Uint16)|(Uint32)|(Int8)|(Int16)|(Int32)|(Float(32)|(64))Array\]$/;
      function isTypedArray(value) {
        return TYPED_ARRAY_REGEXP.test(toString.call(value));
      }
      var trim = function(value) {
        return isString(value) ? value.trim() : value;
      };
      var escapeForRegexp = function(s) {
        return s.replace(/([-()\[\]{}+?*.$\^|,:#<!\\])/g, '\\$1').replace(/\x08/g, '\\x08');
      };
      function isElement(node) {
        return !!(node && (node.nodeName || (node.prop && node.attr && node.find)));
      }
      function makeMap(str) {
        var obj = {},
            items = str.split(","),
            i;
        for (i = 0; i < items.length; i++) {
          obj[items[i]] = true;
        }
        return obj;
      }
      function nodeName_(element) {
        return lowercase(element.nodeName || (element[0] && element[0].nodeName));
      }
      function includes(array, obj) {
        return Array.prototype.indexOf.call(array, obj) != -1;
      }
      function arrayRemove(array, value) {
        var index = array.indexOf(value);
        if (index >= 0) {
          array.splice(index, 1);
        }
        return index;
      }
      function copy(source, destination, stackSource, stackDest) {
        if (isWindow(source) || isScope(source)) {
          throw ngMinErr('cpws', "Can't copy! Making copies of Window or Scope instances is not supported.");
        }
        if (isTypedArray(destination)) {
          throw ngMinErr('cpta', "Can't copy! TypedArray destination cannot be mutated.");
        }
        if (!destination) {
          destination = source;
          if (isObject(source)) {
            var index;
            if (stackSource && (index = stackSource.indexOf(source)) !== -1) {
              return stackDest[index];
            }
            if (isArray(source)) {
              return copy(source, [], stackSource, stackDest);
            } else if (isTypedArray(source)) {
              destination = new source.constructor(source);
            } else if (isDate(source)) {
              destination = new Date(source.getTime());
            } else if (isRegExp(source)) {
              destination = new RegExp(source.source, source.toString().match(/[^\/]*$/)[0]);
              destination.lastIndex = source.lastIndex;
            } else {
              var emptyObject = Object.create(getPrototypeOf(source));
              return copy(source, emptyObject, stackSource, stackDest);
            }
            if (stackDest) {
              stackSource.push(source);
              stackDest.push(destination);
            }
          }
        } else {
          if (source === destination)
            throw ngMinErr('cpi', "Can't copy! Source and destination are identical.");
          stackSource = stackSource || [];
          stackDest = stackDest || [];
          if (isObject(source)) {
            stackSource.push(source);
            stackDest.push(destination);
          }
          var result,
              key;
          if (isArray(source)) {
            destination.length = 0;
            for (var i = 0; i < source.length; i++) {
              destination.push(copy(source[i], null, stackSource, stackDest));
            }
          } else {
            var h = destination.$$hashKey;
            if (isArray(destination)) {
              destination.length = 0;
            } else {
              forEach(destination, function(value, key) {
                delete destination[key];
              });
            }
            if (isBlankObject(source)) {
              for (key in source) {
                destination[key] = copy(source[key], null, stackSource, stackDest);
              }
            } else if (source && typeof source.hasOwnProperty === 'function') {
              for (key in source) {
                if (source.hasOwnProperty(key)) {
                  destination[key] = copy(source[key], null, stackSource, stackDest);
                }
              }
            } else {
              for (key in source) {
                if (hasOwnProperty.call(source, key)) {
                  destination[key] = copy(source[key], null, stackSource, stackDest);
                }
              }
            }
            setHashKey(destination, h);
          }
        }
        return destination;
      }
      function shallowCopy(src, dst) {
        if (isArray(src)) {
          dst = dst || [];
          for (var i = 0,
              ii = src.length; i < ii; i++) {
            dst[i] = src[i];
          }
        } else if (isObject(src)) {
          dst = dst || {};
          for (var key in src) {
            if (!(key.charAt(0) === '$' && key.charAt(1) === '$')) {
              dst[key] = src[key];
            }
          }
        }
        return dst || src;
      }
      function equals(o1, o2) {
        if (o1 === o2)
          return true;
        if (o1 === null || o2 === null)
          return false;
        if (o1 !== o1 && o2 !== o2)
          return true;
        var t1 = typeof o1,
            t2 = typeof o2,
            length,
            key,
            keySet;
        if (t1 == t2) {
          if (t1 == 'object') {
            if (isArray(o1)) {
              if (!isArray(o2))
                return false;
              if ((length = o1.length) == o2.length) {
                for (key = 0; key < length; key++) {
                  if (!equals(o1[key], o2[key]))
                    return false;
                }
                return true;
              }
            } else if (isDate(o1)) {
              if (!isDate(o2))
                return false;
              return equals(o1.getTime(), o2.getTime());
            } else if (isRegExp(o1)) {
              return isRegExp(o2) ? o1.toString() == o2.toString() : false;
            } else {
              if (isScope(o1) || isScope(o2) || isWindow(o1) || isWindow(o2) || isArray(o2) || isDate(o2) || isRegExp(o2))
                return false;
              keySet = createMap();
              for (key in o1) {
                if (key.charAt(0) === '$' || isFunction(o1[key]))
                  continue;
                if (!equals(o1[key], o2[key]))
                  return false;
                keySet[key] = true;
              }
              for (key in o2) {
                if (!(key in keySet) && key.charAt(0) !== '$' && o2[key] !== undefined && !isFunction(o2[key]))
                  return false;
              }
              return true;
            }
          }
        }
        return false;
      }
      var csp = function() {
        if (isDefined(csp.isActive_))
          return csp.isActive_;
        var active = !!(document.querySelector('[ng-csp]') || document.querySelector('[data-ng-csp]'));
        if (!active) {
          try {
            new Function('');
          } catch (e) {
            active = true;
          }
        }
        return (csp.isActive_ = active);
      };
      var jq = function() {
        if (isDefined(jq.name_))
          return jq.name_;
        var el;
        var i,
            ii = ngAttrPrefixes.length,
            prefix,
            name;
        for (i = 0; i < ii; ++i) {
          prefix = ngAttrPrefixes[i];
          if (el = document.querySelector('[' + prefix.replace(':', '\\:') + 'jq]')) {
            name = el.getAttribute(prefix + 'jq');
            break;
          }
        }
        return (jq.name_ = name);
      };
      function concat(array1, array2, index) {
        return array1.concat(slice.call(array2, index));
      }
      function sliceArgs(args, startIndex) {
        return slice.call(args, startIndex || 0);
      }
      function bind(self, fn) {
        var curryArgs = arguments.length > 2 ? sliceArgs(arguments, 2) : [];
        if (isFunction(fn) && !(fn instanceof RegExp)) {
          return curryArgs.length ? function() {
            return arguments.length ? fn.apply(self, concat(curryArgs, arguments, 0)) : fn.apply(self, curryArgs);
          } : function() {
            return arguments.length ? fn.apply(self, arguments) : fn.call(self);
          };
        } else {
          return fn;
        }
      }
      function toJsonReplacer(key, value) {
        var val = value;
        if (typeof key === 'string' && key.charAt(0) === '$' && key.charAt(1) === '$') {
          val = undefined;
        } else if (isWindow(value)) {
          val = '$WINDOW';
        } else if (value && document === value) {
          val = '$DOCUMENT';
        } else if (isScope(value)) {
          val = '$SCOPE';
        }
        return val;
      }
      function toJson(obj, pretty) {
        if (typeof obj === 'undefined')
          return undefined;
        if (!isNumber(pretty)) {
          pretty = pretty ? 2 : null;
        }
        return JSON.stringify(obj, toJsonReplacer, pretty);
      }
      function fromJson(json) {
        return isString(json) ? JSON.parse(json) : json;
      }
      function timezoneToOffset(timezone, fallback) {
        var requestedTimezoneOffset = Date.parse('Jan 01, 1970 00:00:00 ' + timezone) / 60000;
        return isNaN(requestedTimezoneOffset) ? fallback : requestedTimezoneOffset;
      }
      function addDateMinutes(date, minutes) {
        date = new Date(date.getTime());
        date.setMinutes(date.getMinutes() + minutes);
        return date;
      }
      function convertTimezoneToLocal(date, timezone, reverse) {
        reverse = reverse ? -1 : 1;
        var timezoneOffset = timezoneToOffset(timezone, date.getTimezoneOffset());
        return addDateMinutes(date, reverse * (timezoneOffset - date.getTimezoneOffset()));
      }
      function startingTag(element) {
        element = jqLite(element).clone();
        try {
          element.empty();
        } catch (e) {}
        var elemHtml = jqLite('<div>').append(element).html();
        try {
          return element[0].nodeType === NODE_TYPE_TEXT ? lowercase(elemHtml) : elemHtml.match(/^(<[^>]+>)/)[1].replace(/^<([\w\-]+)/, function(match, nodeName) {
            return '<' + lowercase(nodeName);
          });
        } catch (e) {
          return lowercase(elemHtml);
        }
      }
      function tryDecodeURIComponent(value) {
        try {
          return decodeURIComponent(value);
        } catch (e) {}
      }
      function parseKeyValue(keyValue) {
        var obj = {},
            key_value,
            key;
        forEach((keyValue || "").split('&'), function(keyValue) {
          if (keyValue) {
            key_value = keyValue.replace(/\+/g, '%20').split('=');
            key = tryDecodeURIComponent(key_value[0]);
            if (isDefined(key)) {
              var val = isDefined(key_value[1]) ? tryDecodeURIComponent(key_value[1]) : true;
              if (!hasOwnProperty.call(obj, key)) {
                obj[key] = val;
              } else if (isArray(obj[key])) {
                obj[key].push(val);
              } else {
                obj[key] = [obj[key], val];
              }
            }
          }
        });
        return obj;
      }
      function toKeyValue(obj) {
        var parts = [];
        forEach(obj, function(value, key) {
          if (isArray(value)) {
            forEach(value, function(arrayValue) {
              parts.push(encodeUriQuery(key, true) + (arrayValue === true ? '' : '=' + encodeUriQuery(arrayValue, true)));
            });
          } else {
            parts.push(encodeUriQuery(key, true) + (value === true ? '' : '=' + encodeUriQuery(value, true)));
          }
        });
        return parts.length ? parts.join('&') : '';
      }
      function encodeUriSegment(val) {
        return encodeUriQuery(val, true).replace(/%26/gi, '&').replace(/%3D/gi, '=').replace(/%2B/gi, '+');
      }
      function encodeUriQuery(val, pctEncodeSpaces) {
        return encodeURIComponent(val).replace(/%40/gi, '@').replace(/%3A/gi, ':').replace(/%24/g, '$').replace(/%2C/gi, ',').replace(/%3B/gi, ';').replace(/%20/g, (pctEncodeSpaces ? '%20' : '+'));
      }
      var ngAttrPrefixes = ['ng-', 'data-ng-', 'ng:', 'x-ng-'];
      function getNgAttribute(element, ngAttr) {
        var attr,
            i,
            ii = ngAttrPrefixes.length;
        for (i = 0; i < ii; ++i) {
          attr = ngAttrPrefixes[i] + ngAttr;
          if (isString(attr = element.getAttribute(attr))) {
            return attr;
          }
        }
        return null;
      }
      function angularInit(element, bootstrap) {
        var appElement,
            module,
            config = {};
        forEach(ngAttrPrefixes, function(prefix) {
          var name = prefix + 'app';
          if (!appElement && element.hasAttribute && element.hasAttribute(name)) {
            appElement = element;
            module = element.getAttribute(name);
          }
        });
        forEach(ngAttrPrefixes, function(prefix) {
          var name = prefix + 'app';
          var candidate;
          if (!appElement && (candidate = element.querySelector('[' + name.replace(':', '\\:') + ']'))) {
            appElement = candidate;
            module = candidate.getAttribute(name);
          }
        });
        if (appElement) {
          config.strictDi = getNgAttribute(appElement, "strict-di") !== null;
          bootstrap(appElement, module ? [module] : [], config);
        }
      }
      function bootstrap(element, modules, config) {
        if (!isObject(config))
          config = {};
        var defaultConfig = {strictDi: false};
        config = extend(defaultConfig, config);
        var doBootstrap = function() {
          element = jqLite(element);
          if (element.injector()) {
            var tag = (element[0] === document) ? 'document' : startingTag(element);
            throw ngMinErr('btstrpd', "App Already Bootstrapped with this Element '{0}'", tag.replace(/</, '&lt;').replace(/>/, '&gt;'));
          }
          modules = modules || [];
          modules.unshift(['$provide', function($provide) {
            $provide.value('$rootElement', element);
          }]);
          if (config.debugInfoEnabled) {
            modules.push(['$compileProvider', function($compileProvider) {
              $compileProvider.debugInfoEnabled(true);
            }]);
          }
          modules.unshift('ng');
          var injector = createInjector(modules, config.strictDi);
          injector.invoke(['$rootScope', '$rootElement', '$compile', '$injector', function bootstrapApply(scope, element, compile, injector) {
            scope.$apply(function() {
              element.data('$injector', injector);
              compile(element)(scope);
            });
          }]);
          return injector;
        };
        var NG_ENABLE_DEBUG_INFO = /^NG_ENABLE_DEBUG_INFO!/;
        var NG_DEFER_BOOTSTRAP = /^NG_DEFER_BOOTSTRAP!/;
        if (window && NG_ENABLE_DEBUG_INFO.test(window.name)) {
          config.debugInfoEnabled = true;
          window.name = window.name.replace(NG_ENABLE_DEBUG_INFO, '');
        }
        if (window && !NG_DEFER_BOOTSTRAP.test(window.name)) {
          return doBootstrap();
        }
        window.name = window.name.replace(NG_DEFER_BOOTSTRAP, '');
        angular.resumeBootstrap = function(extraModules) {
          forEach(extraModules, function(module) {
            modules.push(module);
          });
          return doBootstrap();
        };
        if (isFunction(angular.resumeDeferredBootstrap)) {
          angular.resumeDeferredBootstrap();
        }
      }
      function reloadWithDebugInfo() {
        window.name = 'NG_ENABLE_DEBUG_INFO!' + window.name;
        window.location.reload();
      }
      function getTestability(rootElement) {
        var injector = angular.element(rootElement).injector();
        if (!injector) {
          throw ngMinErr('test', 'no injector found for element argument to getTestability');
        }
        return injector.get('$$testability');
      }
      var SNAKE_CASE_REGEXP = /[A-Z]/g;
      function snake_case(name, separator) {
        separator = separator || '_';
        return name.replace(SNAKE_CASE_REGEXP, function(letter, pos) {
          return (pos ? separator : '') + letter.toLowerCase();
        });
      }
      var bindJQueryFired = false;
      var skipDestroyOnNextJQueryCleanData;
      function bindJQuery() {
        var originalCleanData;
        if (bindJQueryFired) {
          return ;
        }
        var jqName = jq();
        jQuery = window.jQuery;
        if (isDefined(jqName)) {
          jQuery = jqName === null ? undefined : window[jqName];
        }
        if (jQuery && jQuery.fn.on) {
          jqLite = jQuery;
          extend(jQuery.fn, {
            scope: JQLitePrototype.scope,
            isolateScope: JQLitePrototype.isolateScope,
            controller: JQLitePrototype.controller,
            injector: JQLitePrototype.injector,
            inheritedData: JQLitePrototype.inheritedData
          });
          originalCleanData = jQuery.cleanData;
          jQuery.cleanData = function(elems) {
            var events;
            if (!skipDestroyOnNextJQueryCleanData) {
              for (var i = 0,
                  elem; (elem = elems[i]) != null; i++) {
                events = jQuery._data(elem, "events");
                if (events && events.$destroy) {
                  jQuery(elem).triggerHandler('$destroy');
                }
              }
            } else {
              skipDestroyOnNextJQueryCleanData = false;
            }
            originalCleanData(elems);
          };
        } else {
          jqLite = JQLite;
        }
        angular.element = jqLite;
        bindJQueryFired = true;
      }
      function assertArg(arg, name, reason) {
        if (!arg) {
          throw ngMinErr('areq', "Argument '{0}' is {1}", (name || '?'), (reason || "required"));
        }
        return arg;
      }
      function assertArgFn(arg, name, acceptArrayAnnotation) {
        if (acceptArrayAnnotation && isArray(arg)) {
          arg = arg[arg.length - 1];
        }
        assertArg(isFunction(arg), name, 'not a function, got ' + (arg && typeof arg === 'object' ? arg.constructor.name || 'Object' : typeof arg));
        return arg;
      }
      function assertNotHasOwnProperty(name, context) {
        if (name === 'hasOwnProperty') {
          throw ngMinErr('badname', "hasOwnProperty is not a valid {0} name", context);
        }
      }
      function getter(obj, path, bindFnToScope) {
        if (!path)
          return obj;
        var keys = path.split('.');
        var key;
        var lastInstance = obj;
        var len = keys.length;
        for (var i = 0; i < len; i++) {
          key = keys[i];
          if (obj) {
            obj = (lastInstance = obj)[key];
          }
        }
        if (!bindFnToScope && isFunction(obj)) {
          return bind(lastInstance, obj);
        }
        return obj;
      }
      function getBlockNodes(nodes) {
        var node = nodes[0];
        var endNode = nodes[nodes.length - 1];
        var blockNodes = [node];
        do {
          node = node.nextSibling;
          if (!node)
            break;
          blockNodes.push(node);
        } while (node !== endNode);
        return jqLite(blockNodes);
      }
      function createMap() {
        return Object.create(null);
      }
      var NODE_TYPE_ELEMENT = 1;
      var NODE_TYPE_ATTRIBUTE = 2;
      var NODE_TYPE_TEXT = 3;
      var NODE_TYPE_COMMENT = 8;
      var NODE_TYPE_DOCUMENT = 9;
      var NODE_TYPE_DOCUMENT_FRAGMENT = 11;
      function setupModuleLoader(window) {
        var $injectorMinErr = minErr('$injector');
        var ngMinErr = minErr('ng');
        function ensure(obj, name, factory) {
          return obj[name] || (obj[name] = factory());
        }
        var angular = ensure(window, 'angular', Object);
        angular.$$minErr = angular.$$minErr || minErr;
        return ensure(angular, 'module', function() {
          var modules = {};
          return function module(name, requires, configFn) {
            var assertNotHasOwnProperty = function(name, context) {
              if (name === 'hasOwnProperty') {
                throw ngMinErr('badname', 'hasOwnProperty is not a valid {0} name', context);
              }
            };
            assertNotHasOwnProperty(name, 'module');
            if (requires && modules.hasOwnProperty(name)) {
              modules[name] = null;
            }
            return ensure(modules, name, function() {
              if (!requires) {
                throw $injectorMinErr('nomod', "Module '{0}' is not available! You either misspelled " + "the module name or forgot to load it. If registering a module ensure that you " + "specify the dependencies as the second argument.", name);
              }
              var invokeQueue = [];
              var configBlocks = [];
              var runBlocks = [];
              var config = invokeLater('$injector', 'invoke', 'push', configBlocks);
              var moduleInstance = {
                _invokeQueue: invokeQueue,
                _configBlocks: configBlocks,
                _runBlocks: runBlocks,
                requires: requires,
                name: name,
                provider: invokeLaterAndSetModuleName('$provide', 'provider'),
                factory: invokeLaterAndSetModuleName('$provide', 'factory'),
                service: invokeLaterAndSetModuleName('$provide', 'service'),
                value: invokeLater('$provide', 'value'),
                constant: invokeLater('$provide', 'constant', 'unshift'),
                decorator: invokeLaterAndSetModuleName('$provide', 'decorator'),
                animation: invokeLaterAndSetModuleName('$animateProvider', 'register'),
                filter: invokeLaterAndSetModuleName('$filterProvider', 'register'),
                controller: invokeLaterAndSetModuleName('$controllerProvider', 'register'),
                directive: invokeLaterAndSetModuleName('$compileProvider', 'directive'),
                config: config,
                run: function(block) {
                  runBlocks.push(block);
                  return this;
                }
              };
              if (configFn) {
                config(configFn);
              }
              return moduleInstance;
              function invokeLater(provider, method, insertMethod, queue) {
                if (!queue)
                  queue = invokeQueue;
                return function() {
                  queue[insertMethod || 'push']([provider, method, arguments]);
                  return moduleInstance;
                };
              }
              function invokeLaterAndSetModuleName(provider, method) {
                return function(recipeName, factoryFunction) {
                  if (factoryFunction && isFunction(factoryFunction))
                    factoryFunction.$$moduleName = name;
                  invokeQueue.push([provider, method, arguments]);
                  return moduleInstance;
                };
              }
            });
          };
        });
      }
      function serializeObject(obj) {
        var seen = [];
        return JSON.stringify(obj, function(key, val) {
          val = toJsonReplacer(key, val);
          if (isObject(val)) {
            if (seen.indexOf(val) >= 0)
              return '<<already seen>>';
            seen.push(val);
          }
          return val;
        });
      }
      function toDebugString(obj) {
        if (typeof obj === 'function') {
          return obj.toString().replace(/ \{[\s\S]*$/, '');
        } else if (typeof obj === 'undefined') {
          return 'undefined';
        } else if (typeof obj !== 'string') {
          return serializeObject(obj);
        }
        return obj;
      }
      var version = {
        full: '1.4.1',
        major: 1,
        minor: 4,
        dot: 1,
        codeName: 'hyperionic-illumination'
      };
      function publishExternalAPI(angular) {
        extend(angular, {
          'bootstrap': bootstrap,
          'copy': copy,
          'extend': extend,
          'merge': merge,
          'equals': equals,
          'element': jqLite,
          'forEach': forEach,
          'injector': createInjector,
          'noop': noop,
          'bind': bind,
          'toJson': toJson,
          'fromJson': fromJson,
          'identity': identity,
          'isUndefined': isUndefined,
          'isDefined': isDefined,
          'isString': isString,
          'isFunction': isFunction,
          'isObject': isObject,
          'isNumber': isNumber,
          'isElement': isElement,
          'isArray': isArray,
          'version': version,
          'isDate': isDate,
          'lowercase': lowercase,
          'uppercase': uppercase,
          'callbacks': {counter: 0},
          'getTestability': getTestability,
          '$$minErr': minErr,
          '$$csp': csp,
          'reloadWithDebugInfo': reloadWithDebugInfo
        });
        angularModule = setupModuleLoader(window);
        try {
          angularModule('ngLocale');
        } catch (e) {
          angularModule('ngLocale', []).provider('$locale', $LocaleProvider);
        }
        angularModule('ng', ['ngLocale'], ['$provide', function ngModule($provide) {
          $provide.provider({$$sanitizeUri: $$SanitizeUriProvider});
          $provide.provider('$compile', $CompileProvider).directive({
            a: htmlAnchorDirective,
            input: inputDirective,
            textarea: inputDirective,
            form: formDirective,
            script: scriptDirective,
            select: selectDirective,
            style: styleDirective,
            option: optionDirective,
            ngBind: ngBindDirective,
            ngBindHtml: ngBindHtmlDirective,
            ngBindTemplate: ngBindTemplateDirective,
            ngClass: ngClassDirective,
            ngClassEven: ngClassEvenDirective,
            ngClassOdd: ngClassOddDirective,
            ngCloak: ngCloakDirective,
            ngController: ngControllerDirective,
            ngForm: ngFormDirective,
            ngHide: ngHideDirective,
            ngIf: ngIfDirective,
            ngInclude: ngIncludeDirective,
            ngInit: ngInitDirective,
            ngNonBindable: ngNonBindableDirective,
            ngPluralize: ngPluralizeDirective,
            ngRepeat: ngRepeatDirective,
            ngShow: ngShowDirective,
            ngStyle: ngStyleDirective,
            ngSwitch: ngSwitchDirective,
            ngSwitchWhen: ngSwitchWhenDirective,
            ngSwitchDefault: ngSwitchDefaultDirective,
            ngOptions: ngOptionsDirective,
            ngTransclude: ngTranscludeDirective,
            ngModel: ngModelDirective,
            ngList: ngListDirective,
            ngChange: ngChangeDirective,
            pattern: patternDirective,
            ngPattern: patternDirective,
            required: requiredDirective,
            ngRequired: requiredDirective,
            minlength: minlengthDirective,
            ngMinlength: minlengthDirective,
            maxlength: maxlengthDirective,
            ngMaxlength: maxlengthDirective,
            ngValue: ngValueDirective,
            ngModelOptions: ngModelOptionsDirective
          }).directive({ngInclude: ngIncludeFillContentDirective}).directive(ngAttributeAliasDirectives).directive(ngEventDirectives);
          $provide.provider({
            $anchorScroll: $AnchorScrollProvider,
            $animate: $AnimateProvider,
            $$animateQueue: $$CoreAnimateQueueProvider,
            $$AnimateRunner: $$CoreAnimateRunnerProvider,
            $browser: $BrowserProvider,
            $cacheFactory: $CacheFactoryProvider,
            $controller: $ControllerProvider,
            $document: $DocumentProvider,
            $exceptionHandler: $ExceptionHandlerProvider,
            $filter: $FilterProvider,
            $interpolate: $InterpolateProvider,
            $interval: $IntervalProvider,
            $http: $HttpProvider,
            $httpParamSerializer: $HttpParamSerializerProvider,
            $httpParamSerializerJQLike: $HttpParamSerializerJQLikeProvider,
            $httpBackend: $HttpBackendProvider,
            $location: $LocationProvider,
            $log: $LogProvider,
            $parse: $ParseProvider,
            $rootScope: $RootScopeProvider,
            $q: $QProvider,
            $$q: $$QProvider,
            $sce: $SceProvider,
            $sceDelegate: $SceDelegateProvider,
            $sniffer: $SnifferProvider,
            $templateCache: $TemplateCacheProvider,
            $templateRequest: $TemplateRequestProvider,
            $$testability: $$TestabilityProvider,
            $timeout: $TimeoutProvider,
            $window: $WindowProvider,
            $$rAF: $$RAFProvider,
            $$asyncCallback: $$AsyncCallbackProvider,
            $$jqLite: $$jqLiteProvider,
            $$HashMap: $$HashMapProvider,
            $$cookieReader: $$CookieReaderProvider
          });
        }]);
      }
      JQLite.expando = 'ng339';
      var jqCache = JQLite.cache = {},
          jqId = 1,
          addEventListenerFn = function(element, type, fn) {
            element.addEventListener(type, fn, false);
          },
          removeEventListenerFn = function(element, type, fn) {
            element.removeEventListener(type, fn, false);
          };
      JQLite._data = function(node) {
        return this.cache[node[this.expando]] || {};
      };
      function jqNextId() {
        return ++jqId;
      }
      var SPECIAL_CHARS_REGEXP = /([\:\-\_]+(.))/g;
      var MOZ_HACK_REGEXP = /^moz([A-Z])/;
      var MOUSE_EVENT_MAP = {
        mouseleave: "mouseout",
        mouseenter: "mouseover"
      };
      var jqLiteMinErr = minErr('jqLite');
      function camelCase(name) {
        return name.replace(SPECIAL_CHARS_REGEXP, function(_, separator, letter, offset) {
          return offset ? letter.toUpperCase() : letter;
        }).replace(MOZ_HACK_REGEXP, 'Moz$1');
      }
      var SINGLE_TAG_REGEXP = /^<(\w+)\s*\/?>(?:<\/\1>|)$/;
      var HTML_REGEXP = /<|&#?\w+;/;
      var TAG_NAME_REGEXP = /<([\w:]+)/;
      var XHTML_TAG_REGEXP = /<(?!area|br|col|embed|hr|img|input|link|meta|param)(([\w:]+)[^>]*)\/>/gi;
      var wrapMap = {
        'option': [1, '<select multiple="multiple">', '</select>'],
        'thead': [1, '<table>', '</table>'],
        'col': [2, '<table><colgroup>', '</colgroup></table>'],
        'tr': [2, '<table><tbody>', '</tbody></table>'],
        'td': [3, '<table><tbody><tr>', '</tr></tbody></table>'],
        '_default': [0, "", ""]
      };
      wrapMap.optgroup = wrapMap.option;
      wrapMap.tbody = wrapMap.tfoot = wrapMap.colgroup = wrapMap.caption = wrapMap.thead;
      wrapMap.th = wrapMap.td;
      function jqLiteIsTextNode(html) {
        return !HTML_REGEXP.test(html);
      }
      function jqLiteAcceptsData(node) {
        var nodeType = node.nodeType;
        return nodeType === NODE_TYPE_ELEMENT || !nodeType || nodeType === NODE_TYPE_DOCUMENT;
      }
      function jqLiteHasData(node) {
        for (var key in jqCache[node.ng339]) {
          return true;
        }
        return false;
      }
      function jqLiteBuildFragment(html, context) {
        var tmp,
            tag,
            wrap,
            fragment = context.createDocumentFragment(),
            nodes = [],
            i;
        if (jqLiteIsTextNode(html)) {
          nodes.push(context.createTextNode(html));
        } else {
          tmp = tmp || fragment.appendChild(context.createElement("div"));
          tag = (TAG_NAME_REGEXP.exec(html) || ["", ""])[1].toLowerCase();
          wrap = wrapMap[tag] || wrapMap._default;
          tmp.innerHTML = wrap[1] + html.replace(XHTML_TAG_REGEXP, "<$1></$2>") + wrap[2];
          i = wrap[0];
          while (i--) {
            tmp = tmp.lastChild;
          }
          nodes = concat(nodes, tmp.childNodes);
          tmp = fragment.firstChild;
          tmp.textContent = "";
        }
        fragment.textContent = "";
        fragment.innerHTML = "";
        forEach(nodes, function(node) {
          fragment.appendChild(node);
        });
        return fragment;
      }
      function jqLiteParseHTML(html, context) {
        context = context || document;
        var parsed;
        if ((parsed = SINGLE_TAG_REGEXP.exec(html))) {
          return [context.createElement(parsed[1])];
        }
        if ((parsed = jqLiteBuildFragment(html, context))) {
          return parsed.childNodes;
        }
        return [];
      }
      function JQLite(element) {
        if (element instanceof JQLite) {
          return element;
        }
        var argIsString;
        if (isString(element)) {
          element = trim(element);
          argIsString = true;
        }
        if (!(this instanceof JQLite)) {
          if (argIsString && element.charAt(0) != '<') {
            throw jqLiteMinErr('nosel', 'Looking up elements via selectors is not supported by jqLite! See: http://docs.angularjs.org/api/angular.element');
          }
          return new JQLite(element);
        }
        if (argIsString) {
          jqLiteAddNodes(this, jqLiteParseHTML(element));
        } else {
          jqLiteAddNodes(this, element);
        }
      }
      function jqLiteClone(element) {
        return element.cloneNode(true);
      }
      function jqLiteDealoc(element, onlyDescendants) {
        if (!onlyDescendants)
          jqLiteRemoveData(element);
        if (element.querySelectorAll) {
          var descendants = element.querySelectorAll('*');
          for (var i = 0,
              l = descendants.length; i < l; i++) {
            jqLiteRemoveData(descendants[i]);
          }
        }
      }
      function jqLiteOff(element, type, fn, unsupported) {
        if (isDefined(unsupported))
          throw jqLiteMinErr('offargs', 'jqLite#off() does not support the `selector` argument');
        var expandoStore = jqLiteExpandoStore(element);
        var events = expandoStore && expandoStore.events;
        var handle = expandoStore && expandoStore.handle;
        if (!handle)
          return ;
        if (!type) {
          for (type in events) {
            if (type !== '$destroy') {
              removeEventListenerFn(element, type, handle);
            }
            delete events[type];
          }
        } else {
          forEach(type.split(' '), function(type) {
            if (isDefined(fn)) {
              var listenerFns = events[type];
              arrayRemove(listenerFns || [], fn);
              if (listenerFns && listenerFns.length > 0) {
                return ;
              }
            }
            removeEventListenerFn(element, type, handle);
            delete events[type];
          });
        }
      }
      function jqLiteRemoveData(element, name) {
        var expandoId = element.ng339;
        var expandoStore = expandoId && jqCache[expandoId];
        if (expandoStore) {
          if (name) {
            delete expandoStore.data[name];
            return ;
          }
          if (expandoStore.handle) {
            if (expandoStore.events.$destroy) {
              expandoStore.handle({}, '$destroy');
            }
            jqLiteOff(element);
          }
          delete jqCache[expandoId];
          element.ng339 = undefined;
        }
      }
      function jqLiteExpandoStore(element, createIfNecessary) {
        var expandoId = element.ng339,
            expandoStore = expandoId && jqCache[expandoId];
        if (createIfNecessary && !expandoStore) {
          element.ng339 = expandoId = jqNextId();
          expandoStore = jqCache[expandoId] = {
            events: {},
            data: {},
            handle: undefined
          };
        }
        return expandoStore;
      }
      function jqLiteData(element, key, value) {
        if (jqLiteAcceptsData(element)) {
          var isSimpleSetter = isDefined(value);
          var isSimpleGetter = !isSimpleSetter && key && !isObject(key);
          var massGetter = !key;
          var expandoStore = jqLiteExpandoStore(element, !isSimpleGetter);
          var data = expandoStore && expandoStore.data;
          if (isSimpleSetter) {
            data[key] = value;
          } else {
            if (massGetter) {
              return data;
            } else {
              if (isSimpleGetter) {
                return data && data[key];
              } else {
                extend(data, key);
              }
            }
          }
        }
      }
      function jqLiteHasClass(element, selector) {
        if (!element.getAttribute)
          return false;
        return ((" " + (element.getAttribute('class') || '') + " ").replace(/[\n\t]/g, " ").indexOf(" " + selector + " ") > -1);
      }
      function jqLiteRemoveClass(element, cssClasses) {
        if (cssClasses && element.setAttribute) {
          forEach(cssClasses.split(' '), function(cssClass) {
            element.setAttribute('class', trim((" " + (element.getAttribute('class') || '') + " ").replace(/[\n\t]/g, " ").replace(" " + trim(cssClass) + " ", " ")));
          });
        }
      }
      function jqLiteAddClass(element, cssClasses) {
        if (cssClasses && element.setAttribute) {
          var existingClasses = (' ' + (element.getAttribute('class') || '') + ' ').replace(/[\n\t]/g, " ");
          forEach(cssClasses.split(' '), function(cssClass) {
            cssClass = trim(cssClass);
            if (existingClasses.indexOf(' ' + cssClass + ' ') === -1) {
              existingClasses += cssClass + ' ';
            }
          });
          element.setAttribute('class', trim(existingClasses));
        }
      }
      function jqLiteAddNodes(root, elements) {
        if (elements) {
          if (elements.nodeType) {
            root[root.length++] = elements;
          } else {
            var length = elements.length;
            if (typeof length === 'number' && elements.window !== elements) {
              if (length) {
                for (var i = 0; i < length; i++) {
                  root[root.length++] = elements[i];
                }
              }
            } else {
              root[root.length++] = elements;
            }
          }
        }
      }
      function jqLiteController(element, name) {
        return jqLiteInheritedData(element, '$' + (name || 'ngController') + 'Controller');
      }
      function jqLiteInheritedData(element, name, value) {
        if (element.nodeType == NODE_TYPE_DOCUMENT) {
          element = element.documentElement;
        }
        var names = isArray(name) ? name : [name];
        while (element) {
          for (var i = 0,
              ii = names.length; i < ii; i++) {
            if ((value = jqLite.data(element, names[i])) !== undefined)
              return value;
          }
          element = element.parentNode || (element.nodeType === NODE_TYPE_DOCUMENT_FRAGMENT && element.host);
        }
      }
      function jqLiteEmpty(element) {
        jqLiteDealoc(element, true);
        while (element.firstChild) {
          element.removeChild(element.firstChild);
        }
      }
      function jqLiteRemove(element, keepData) {
        if (!keepData)
          jqLiteDealoc(element);
        var parent = element.parentNode;
        if (parent)
          parent.removeChild(element);
      }
      function jqLiteDocumentLoaded(action, win) {
        win = win || window;
        if (win.document.readyState === 'complete') {
          win.setTimeout(action);
        } else {
          jqLite(win).on('load', action);
        }
      }
      var JQLitePrototype = JQLite.prototype = {
        ready: function(fn) {
          var fired = false;
          function trigger() {
            if (fired)
              return ;
            fired = true;
            fn();
          }
          if (document.readyState === 'complete') {
            setTimeout(trigger);
          } else {
            this.on('DOMContentLoaded', trigger);
            JQLite(window).on('load', trigger);
          }
        },
        toString: function() {
          var value = [];
          forEach(this, function(e) {
            value.push('' + e);
          });
          return '[' + value.join(', ') + ']';
        },
        eq: function(index) {
          return (index >= 0) ? jqLite(this[index]) : jqLite(this[this.length + index]);
        },
        length: 0,
        push: push,
        sort: [].sort,
        splice: [].splice
      };
      var BOOLEAN_ATTR = {};
      forEach('multiple,selected,checked,disabled,readOnly,required,open'.split(','), function(value) {
        BOOLEAN_ATTR[lowercase(value)] = value;
      });
      var BOOLEAN_ELEMENTS = {};
      forEach('input,select,option,textarea,button,form,details'.split(','), function(value) {
        BOOLEAN_ELEMENTS[value] = true;
      });
      var ALIASED_ATTR = {
        'ngMinlength': 'minlength',
        'ngMaxlength': 'maxlength',
        'ngMin': 'min',
        'ngMax': 'max',
        'ngPattern': 'pattern'
      };
      function getBooleanAttrName(element, name) {
        var booleanAttr = BOOLEAN_ATTR[name.toLowerCase()];
        return booleanAttr && BOOLEAN_ELEMENTS[nodeName_(element)] && booleanAttr;
      }
      function getAliasedAttrName(element, name) {
        var nodeName = element.nodeName;
        return (nodeName === 'INPUT' || nodeName === 'TEXTAREA') && ALIASED_ATTR[name];
      }
      forEach({
        data: jqLiteData,
        removeData: jqLiteRemoveData,
        hasData: jqLiteHasData
      }, function(fn, name) {
        JQLite[name] = fn;
      });
      forEach({
        data: jqLiteData,
        inheritedData: jqLiteInheritedData,
        scope: function(element) {
          return jqLite.data(element, '$scope') || jqLiteInheritedData(element.parentNode || element, ['$isolateScope', '$scope']);
        },
        isolateScope: function(element) {
          return jqLite.data(element, '$isolateScope') || jqLite.data(element, '$isolateScopeNoTemplate');
        },
        controller: jqLiteController,
        injector: function(element) {
          return jqLiteInheritedData(element, '$injector');
        },
        removeAttr: function(element, name) {
          element.removeAttribute(name);
        },
        hasClass: jqLiteHasClass,
        css: function(element, name, value) {
          name = camelCase(name);
          if (isDefined(value)) {
            element.style[name] = value;
          } else {
            return element.style[name];
          }
        },
        attr: function(element, name, value) {
          var nodeType = element.nodeType;
          if (nodeType === NODE_TYPE_TEXT || nodeType === NODE_TYPE_ATTRIBUTE || nodeType === NODE_TYPE_COMMENT) {
            return ;
          }
          var lowercasedName = lowercase(name);
          if (BOOLEAN_ATTR[lowercasedName]) {
            if (isDefined(value)) {
              if (!!value) {
                element[name] = true;
                element.setAttribute(name, lowercasedName);
              } else {
                element[name] = false;
                element.removeAttribute(lowercasedName);
              }
            } else {
              return (element[name] || (element.attributes.getNamedItem(name) || noop).specified) ? lowercasedName : undefined;
            }
          } else if (isDefined(value)) {
            element.setAttribute(name, value);
          } else if (element.getAttribute) {
            var ret = element.getAttribute(name, 2);
            return ret === null ? undefined : ret;
          }
        },
        prop: function(element, name, value) {
          if (isDefined(value)) {
            element[name] = value;
          } else {
            return element[name];
          }
        },
        text: (function() {
          getText.$dv = '';
          return getText;
          function getText(element, value) {
            if (isUndefined(value)) {
              var nodeType = element.nodeType;
              return (nodeType === NODE_TYPE_ELEMENT || nodeType === NODE_TYPE_TEXT) ? element.textContent : '';
            }
            element.textContent = value;
          }
        })(),
        val: function(element, value) {
          if (isUndefined(value)) {
            if (element.multiple && nodeName_(element) === 'select') {
              var result = [];
              forEach(element.options, function(option) {
                if (option.selected) {
                  result.push(option.value || option.text);
                }
              });
              return result.length === 0 ? null : result;
            }
            return element.value;
          }
          element.value = value;
        },
        html: function(element, value) {
          if (isUndefined(value)) {
            return element.innerHTML;
          }
          jqLiteDealoc(element, true);
          element.innerHTML = value;
        },
        empty: jqLiteEmpty
      }, function(fn, name) {
        JQLite.prototype[name] = function(arg1, arg2) {
          var i,
              key;
          var nodeCount = this.length;
          if (fn !== jqLiteEmpty && (((fn.length == 2 && (fn !== jqLiteHasClass && fn !== jqLiteController)) ? arg1 : arg2) === undefined)) {
            if (isObject(arg1)) {
              for (i = 0; i < nodeCount; i++) {
                if (fn === jqLiteData) {
                  fn(this[i], arg1);
                } else {
                  for (key in arg1) {
                    fn(this[i], key, arg1[key]);
                  }
                }
              }
              return this;
            } else {
              var value = fn.$dv;
              var jj = (value === undefined) ? Math.min(nodeCount, 1) : nodeCount;
              for (var j = 0; j < jj; j++) {
                var nodeValue = fn(this[j], arg1, arg2);
                value = value ? value + nodeValue : nodeValue;
              }
              return value;
            }
          } else {
            for (i = 0; i < nodeCount; i++) {
              fn(this[i], arg1, arg2);
            }
            return this;
          }
        };
      });
      function createEventHandler(element, events) {
        var eventHandler = function(event, type) {
          event.isDefaultPrevented = function() {
            return event.defaultPrevented;
          };
          var eventFns = events[type || event.type];
          var eventFnsLength = eventFns ? eventFns.length : 0;
          if (!eventFnsLength)
            return ;
          if (isUndefined(event.immediatePropagationStopped)) {
            var originalStopImmediatePropagation = event.stopImmediatePropagation;
            event.stopImmediatePropagation = function() {
              event.immediatePropagationStopped = true;
              if (event.stopPropagation) {
                event.stopPropagation();
              }
              if (originalStopImmediatePropagation) {
                originalStopImmediatePropagation.call(event);
              }
            };
          }
          event.isImmediatePropagationStopped = function() {
            return event.immediatePropagationStopped === true;
          };
          if ((eventFnsLength > 1)) {
            eventFns = shallowCopy(eventFns);
          }
          for (var i = 0; i < eventFnsLength; i++) {
            if (!event.isImmediatePropagationStopped()) {
              eventFns[i].call(element, event);
            }
          }
        };
        eventHandler.elem = element;
        return eventHandler;
      }
      forEach({
        removeData: jqLiteRemoveData,
        on: function jqLiteOn(element, type, fn, unsupported) {
          if (isDefined(unsupported))
            throw jqLiteMinErr('onargs', 'jqLite#on() does not support the `selector` or `eventData` parameters');
          if (!jqLiteAcceptsData(element)) {
            return ;
          }
          var expandoStore = jqLiteExpandoStore(element, true);
          var events = expandoStore.events;
          var handle = expandoStore.handle;
          if (!handle) {
            handle = expandoStore.handle = createEventHandler(element, events);
          }
          var types = type.indexOf(' ') >= 0 ? type.split(' ') : [type];
          var i = types.length;
          while (i--) {
            type = types[i];
            var eventFns = events[type];
            if (!eventFns) {
              events[type] = [];
              if (type === 'mouseenter' || type === 'mouseleave') {
                jqLiteOn(element, MOUSE_EVENT_MAP[type], function(event) {
                  var target = this,
                      related = event.relatedTarget;
                  if (!related || (related !== target && !target.contains(related))) {
                    handle(event, type);
                  }
                });
              } else {
                if (type !== '$destroy') {
                  addEventListenerFn(element, type, handle);
                }
              }
              eventFns = events[type];
            }
            eventFns.push(fn);
          }
        },
        off: jqLiteOff,
        one: function(element, type, fn) {
          element = jqLite(element);
          element.on(type, function onFn() {
            element.off(type, fn);
            element.off(type, onFn);
          });
          element.on(type, fn);
        },
        replaceWith: function(element, replaceNode) {
          var index,
              parent = element.parentNode;
          jqLiteDealoc(element);
          forEach(new JQLite(replaceNode), function(node) {
            if (index) {
              parent.insertBefore(node, index.nextSibling);
            } else {
              parent.replaceChild(node, element);
            }
            index = node;
          });
        },
        children: function(element) {
          var children = [];
          forEach(element.childNodes, function(element) {
            if (element.nodeType === NODE_TYPE_ELEMENT) {
              children.push(element);
            }
          });
          return children;
        },
        contents: function(element) {
          return element.contentDocument || element.childNodes || [];
        },
        append: function(element, node) {
          var nodeType = element.nodeType;
          if (nodeType !== NODE_TYPE_ELEMENT && nodeType !== NODE_TYPE_DOCUMENT_FRAGMENT)
            return ;
          node = new JQLite(node);
          for (var i = 0,
              ii = node.length; i < ii; i++) {
            var child = node[i];
            element.appendChild(child);
          }
        },
        prepend: function(element, node) {
          if (element.nodeType === NODE_TYPE_ELEMENT) {
            var index = element.firstChild;
            forEach(new JQLite(node), function(child) {
              element.insertBefore(child, index);
            });
          }
        },
        wrap: function(element, wrapNode) {
          wrapNode = jqLite(wrapNode).eq(0).clone()[0];
          var parent = element.parentNode;
          if (parent) {
            parent.replaceChild(wrapNode, element);
          }
          wrapNode.appendChild(element);
        },
        remove: jqLiteRemove,
        detach: function(element) {
          jqLiteRemove(element, true);
        },
        after: function(element, newElement) {
          var index = element,
              parent = element.parentNode;
          newElement = new JQLite(newElement);
          for (var i = 0,
              ii = newElement.length; i < ii; i++) {
            var node = newElement[i];
            parent.insertBefore(node, index.nextSibling);
            index = node;
          }
        },
        addClass: jqLiteAddClass,
        removeClass: jqLiteRemoveClass,
        toggleClass: function(element, selector, condition) {
          if (selector) {
            forEach(selector.split(' '), function(className) {
              var classCondition = condition;
              if (isUndefined(classCondition)) {
                classCondition = !jqLiteHasClass(element, className);
              }
              (classCondition ? jqLiteAddClass : jqLiteRemoveClass)(element, className);
            });
          }
        },
        parent: function(element) {
          var parent = element.parentNode;
          return parent && parent.nodeType !== NODE_TYPE_DOCUMENT_FRAGMENT ? parent : null;
        },
        next: function(element) {
          return element.nextElementSibling;
        },
        find: function(element, selector) {
          if (element.getElementsByTagName) {
            return element.getElementsByTagName(selector);
          } else {
            return [];
          }
        },
        clone: jqLiteClone,
        triggerHandler: function(element, event, extraParameters) {
          var dummyEvent,
              eventFnsCopy,
              handlerArgs;
          var eventName = event.type || event;
          var expandoStore = jqLiteExpandoStore(element);
          var events = expandoStore && expandoStore.events;
          var eventFns = events && events[eventName];
          if (eventFns) {
            dummyEvent = {
              preventDefault: function() {
                this.defaultPrevented = true;
              },
              isDefaultPrevented: function() {
                return this.defaultPrevented === true;
              },
              stopImmediatePropagation: function() {
                this.immediatePropagationStopped = true;
              },
              isImmediatePropagationStopped: function() {
                return this.immediatePropagationStopped === true;
              },
              stopPropagation: noop,
              type: eventName,
              target: element
            };
            if (event.type) {
              dummyEvent = extend(dummyEvent, event);
            }
            eventFnsCopy = shallowCopy(eventFns);
            handlerArgs = extraParameters ? [dummyEvent].concat(extraParameters) : [dummyEvent];
            forEach(eventFnsCopy, function(fn) {
              if (!dummyEvent.isImmediatePropagationStopped()) {
                fn.apply(element, handlerArgs);
              }
            });
          }
        }
      }, function(fn, name) {
        JQLite.prototype[name] = function(arg1, arg2, arg3) {
          var value;
          for (var i = 0,
              ii = this.length; i < ii; i++) {
            if (isUndefined(value)) {
              value = fn(this[i], arg1, arg2, arg3);
              if (isDefined(value)) {
                value = jqLite(value);
              }
            } else {
              jqLiteAddNodes(value, fn(this[i], arg1, arg2, arg3));
            }
          }
          return isDefined(value) ? value : this;
        };
        JQLite.prototype.bind = JQLite.prototype.on;
        JQLite.prototype.unbind = JQLite.prototype.off;
      });
      function $$jqLiteProvider() {
        this.$get = function $$jqLite() {
          return extend(JQLite, {
            hasClass: function(node, classes) {
              if (node.attr)
                node = node[0];
              return jqLiteHasClass(node, classes);
            },
            addClass: function(node, classes) {
              if (node.attr)
                node = node[0];
              return jqLiteAddClass(node, classes);
            },
            removeClass: function(node, classes) {
              if (node.attr)
                node = node[0];
              return jqLiteRemoveClass(node, classes);
            }
          });
        };
      }
      function hashKey(obj, nextUidFn) {
        var key = obj && obj.$$hashKey;
        if (key) {
          if (typeof key === 'function') {
            key = obj.$$hashKey();
          }
          return key;
        }
        var objType = typeof obj;
        if (objType == 'function' || (objType == 'object' && obj !== null)) {
          key = obj.$$hashKey = objType + ':' + (nextUidFn || nextUid)();
        } else {
          key = objType + ':' + obj;
        }
        return key;
      }
      function HashMap(array, isolatedUid) {
        if (isolatedUid) {
          var uid = 0;
          this.nextUid = function() {
            return ++uid;
          };
        }
        forEach(array, this.put, this);
      }
      HashMap.prototype = {
        put: function(key, value) {
          this[hashKey(key, this.nextUid)] = value;
        },
        get: function(key) {
          return this[hashKey(key, this.nextUid)];
        },
        remove: function(key) {
          var value = this[key = hashKey(key, this.nextUid)];
          delete this[key];
          return value;
        }
      };
      var $$HashMapProvider = [function() {
        this.$get = [function() {
          return HashMap;
        }];
      }];
      var FN_ARGS = /^function\s*[^\(]*\(\s*([^\)]*)\)/m;
      var FN_ARG_SPLIT = /,/;
      var FN_ARG = /^\s*(_?)(\S+?)\1\s*$/;
      var STRIP_COMMENTS = /((\/\/.*$)|(\/\*[\s\S]*?\*\/))/mg;
      var $injectorMinErr = minErr('$injector');
      function anonFn(fn) {
        var fnText = fn.toString().replace(STRIP_COMMENTS, ''),
            args = fnText.match(FN_ARGS);
        if (args) {
          return 'function(' + (args[1] || '').replace(/[\s\r\n]+/, ' ') + ')';
        }
        return 'fn';
      }
      function annotate(fn, strictDi, name) {
        var $inject,
            fnText,
            argDecl,
            last;
        if (typeof fn === 'function') {
          if (!($inject = fn.$inject)) {
            $inject = [];
            if (fn.length) {
              if (strictDi) {
                if (!isString(name) || !name) {
                  name = fn.name || anonFn(fn);
                }
                throw $injectorMinErr('strictdi', '{0} is not using explicit annotation and cannot be invoked in strict mode', name);
              }
              fnText = fn.toString().replace(STRIP_COMMENTS, '');
              argDecl = fnText.match(FN_ARGS);
              forEach(argDecl[1].split(FN_ARG_SPLIT), function(arg) {
                arg.replace(FN_ARG, function(all, underscore, name) {
                  $inject.push(name);
                });
              });
            }
            fn.$inject = $inject;
          }
        } else if (isArray(fn)) {
          last = fn.length - 1;
          assertArgFn(fn[last], 'fn');
          $inject = fn.slice(0, last);
        } else {
          assertArgFn(fn, 'fn', true);
        }
        return $inject;
      }
      function createInjector(modulesToLoad, strictDi) {
        strictDi = (strictDi === true);
        var INSTANTIATING = {},
            providerSuffix = 'Provider',
            path = [],
            loadedModules = new HashMap([], true),
            providerCache = {$provide: {
                provider: supportObject(provider),
                factory: supportObject(factory),
                service: supportObject(service),
                value: supportObject(value),
                constant: supportObject(constant),
                decorator: decorator
              }},
            providerInjector = (providerCache.$injector = createInternalInjector(providerCache, function(serviceName, caller) {
              if (angular.isString(caller)) {
                path.push(caller);
              }
              throw $injectorMinErr('unpr', "Unknown provider: {0}", path.join(' <- '));
            })),
            instanceCache = {},
            instanceInjector = (instanceCache.$injector = createInternalInjector(instanceCache, function(serviceName, caller) {
              var provider = providerInjector.get(serviceName + providerSuffix, caller);
              return instanceInjector.invoke(provider.$get, provider, undefined, serviceName);
            }));
        forEach(loadModules(modulesToLoad), function(fn) {
          if (fn)
            instanceInjector.invoke(fn);
        });
        return instanceInjector;
        function supportObject(delegate) {
          return function(key, value) {
            if (isObject(key)) {
              forEach(key, reverseParams(delegate));
            } else {
              return delegate(key, value);
            }
          };
        }
        function provider(name, provider_) {
          assertNotHasOwnProperty(name, 'service');
          if (isFunction(provider_) || isArray(provider_)) {
            provider_ = providerInjector.instantiate(provider_);
          }
          if (!provider_.$get) {
            throw $injectorMinErr('pget', "Provider '{0}' must define $get factory method.", name);
          }
          return providerCache[name + providerSuffix] = provider_;
        }
        function enforceReturnValue(name, factory) {
          return function enforcedReturnValue() {
            var result = instanceInjector.invoke(factory, this);
            if (isUndefined(result)) {
              throw $injectorMinErr('undef', "Provider '{0}' must return a value from $get factory method.", name);
            }
            return result;
          };
        }
        function factory(name, factoryFn, enforce) {
          return provider(name, {$get: enforce !== false ? enforceReturnValue(name, factoryFn) : factoryFn});
        }
        function service(name, constructor) {
          return factory(name, ['$injector', function($injector) {
            return $injector.instantiate(constructor);
          }]);
        }
        function value(name, val) {
          return factory(name, valueFn(val), false);
        }
        function constant(name, value) {
          assertNotHasOwnProperty(name, 'constant');
          providerCache[name] = value;
          instanceCache[name] = value;
        }
        function decorator(serviceName, decorFn) {
          var origProvider = providerInjector.get(serviceName + providerSuffix),
              orig$get = origProvider.$get;
          origProvider.$get = function() {
            var origInstance = instanceInjector.invoke(orig$get, origProvider);
            return instanceInjector.invoke(decorFn, null, {$delegate: origInstance});
          };
        }
        function loadModules(modulesToLoad) {
          var runBlocks = [],
              moduleFn;
          forEach(modulesToLoad, function(module) {
            if (loadedModules.get(module))
              return ;
            loadedModules.put(module, true);
            function runInvokeQueue(queue) {
              var i,
                  ii;
              for (i = 0, ii = queue.length; i < ii; i++) {
                var invokeArgs = queue[i],
                    provider = providerInjector.get(invokeArgs[0]);
                provider[invokeArgs[1]].apply(provider, invokeArgs[2]);
              }
            }
            try {
              if (isString(module)) {
                moduleFn = angularModule(module);
                runBlocks = runBlocks.concat(loadModules(moduleFn.requires)).concat(moduleFn._runBlocks);
                runInvokeQueue(moduleFn._invokeQueue);
                runInvokeQueue(moduleFn._configBlocks);
              } else if (isFunction(module)) {
                runBlocks.push(providerInjector.invoke(module));
              } else if (isArray(module)) {
                runBlocks.push(providerInjector.invoke(module));
              } else {
                assertArgFn(module, 'module');
              }
            } catch (e) {
              if (isArray(module)) {
                module = module[module.length - 1];
              }
              if (e.message && e.stack && e.stack.indexOf(e.message) == -1) {
                e = e.message + '\n' + e.stack;
              }
              throw $injectorMinErr('modulerr', "Failed to instantiate module {0} due to:\n{1}", module, e.stack || e.message || e);
            }
          });
          return runBlocks;
        }
        function createInternalInjector(cache, factory) {
          function getService(serviceName, caller) {
            if (cache.hasOwnProperty(serviceName)) {
              if (cache[serviceName] === INSTANTIATING) {
                throw $injectorMinErr('cdep', 'Circular dependency found: {0}', serviceName + ' <- ' + path.join(' <- '));
              }
              return cache[serviceName];
            } else {
              try {
                path.unshift(serviceName);
                cache[serviceName] = INSTANTIATING;
                return cache[serviceName] = factory(serviceName, caller);
              } catch (err) {
                if (cache[serviceName] === INSTANTIATING) {
                  delete cache[serviceName];
                }
                throw err;
              } finally {
                path.shift();
              }
            }
          }
          function invoke(fn, self, locals, serviceName) {
            if (typeof locals === 'string') {
              serviceName = locals;
              locals = null;
            }
            var args = [],
                $inject = createInjector.$$annotate(fn, strictDi, serviceName),
                length,
                i,
                key;
            for (i = 0, length = $inject.length; i < length; i++) {
              key = $inject[i];
              if (typeof key !== 'string') {
                throw $injectorMinErr('itkn', 'Incorrect injection token! Expected service name as string, got {0}', key);
              }
              args.push(locals && locals.hasOwnProperty(key) ? locals[key] : getService(key, serviceName));
            }
            if (isArray(fn)) {
              fn = fn[length];
            }
            return fn.apply(self, args);
          }
          function instantiate(Type, locals, serviceName) {
            var instance = Object.create((isArray(Type) ? Type[Type.length - 1] : Type).prototype || null);
            var returnedValue = invoke(Type, instance, locals, serviceName);
            return isObject(returnedValue) || isFunction(returnedValue) ? returnedValue : instance;
          }
          return {
            invoke: invoke,
            instantiate: instantiate,
            get: getService,
            annotate: createInjector.$$annotate,
            has: function(name) {
              return providerCache.hasOwnProperty(name + providerSuffix) || cache.hasOwnProperty(name);
            }
          };
        }
      }
      createInjector.$$annotate = annotate;
      function $AnchorScrollProvider() {
        var autoScrollingEnabled = true;
        this.disableAutoScrolling = function() {
          autoScrollingEnabled = false;
        };
        this.$get = ['$window', '$location', '$rootScope', function($window, $location, $rootScope) {
          var document = $window.document;
          function getFirstAnchor(list) {
            var result = null;
            Array.prototype.some.call(list, function(element) {
              if (nodeName_(element) === 'a') {
                result = element;
                return true;
              }
            });
            return result;
          }
          function getYOffset() {
            var offset = scroll.yOffset;
            if (isFunction(offset)) {
              offset = offset();
            } else if (isElement(offset)) {
              var elem = offset[0];
              var style = $window.getComputedStyle(elem);
              if (style.position !== 'fixed') {
                offset = 0;
              } else {
                offset = elem.getBoundingClientRect().bottom;
              }
            } else if (!isNumber(offset)) {
              offset = 0;
            }
            return offset;
          }
          function scrollTo(elem) {
            if (elem) {
              elem.scrollIntoView();
              var offset = getYOffset();
              if (offset) {
                var elemTop = elem.getBoundingClientRect().top;
                $window.scrollBy(0, elemTop - offset);
              }
            } else {
              $window.scrollTo(0, 0);
            }
          }
          function scroll(hash) {
            hash = isString(hash) ? hash : $location.hash();
            var elm;
            if (!hash)
              scrollTo(null);
            else if ((elm = document.getElementById(hash)))
              scrollTo(elm);
            else if ((elm = getFirstAnchor(document.getElementsByName(hash))))
              scrollTo(elm);
            else if (hash === 'top')
              scrollTo(null);
          }
          if (autoScrollingEnabled) {
            $rootScope.$watch(function autoScrollWatch() {
              return $location.hash();
            }, function autoScrollWatchAction(newVal, oldVal) {
              if (newVal === oldVal && newVal === '')
                return ;
              jqLiteDocumentLoaded(function() {
                $rootScope.$evalAsync(scroll);
              });
            });
          }
          return scroll;
        }];
      }
      var $animateMinErr = minErr('$animate');
      var ELEMENT_NODE = 1;
      var NG_ANIMATE_CLASSNAME = 'ng-animate';
      function mergeClasses(a, b) {
        if (!a && !b)
          return '';
        if (!a)
          return b;
        if (!b)
          return a;
        if (isArray(a))
          a = a.join(' ');
        if (isArray(b))
          b = b.join(' ');
        return a + ' ' + b;
      }
      function extractElementNode(element) {
        for (var i = 0; i < element.length; i++) {
          var elm = element[i];
          if (elm.nodeType === ELEMENT_NODE) {
            return elm;
          }
        }
      }
      function splitClasses(classes) {
        if (isString(classes)) {
          classes = classes.split(' ');
        }
        var obj = createMap();
        forEach(classes, function(klass) {
          if (klass.length) {
            obj[klass] = true;
          }
        });
        return obj;
      }
      function prepareAnimateOptions(options) {
        return isObject(options) ? options : {};
      }
      var $$CoreAnimateRunnerProvider = function() {
        this.$get = ['$q', '$$rAF', function($q, $$rAF) {
          function AnimateRunner() {}
          AnimateRunner.all = noop;
          AnimateRunner.chain = noop;
          AnimateRunner.prototype = {
            end: noop,
            cancel: noop,
            resume: noop,
            pause: noop,
            complete: noop,
            then: function(pass, fail) {
              return $q(function(resolve) {
                $$rAF(function() {
                  resolve();
                });
              }).then(pass, fail);
            }
          };
          return AnimateRunner;
        }];
      };
      var $$CoreAnimateQueueProvider = function() {
        var postDigestQueue = new HashMap();
        var postDigestElements = [];
        this.$get = ['$$AnimateRunner', '$rootScope', function($$AnimateRunner, $rootScope) {
          return {
            enabled: noop,
            on: noop,
            off: noop,
            pin: noop,
            push: function(element, event, options, domOperation) {
              domOperation && domOperation();
              options = options || {};
              options.from && element.css(options.from);
              options.to && element.css(options.to);
              if (options.addClass || options.removeClass) {
                addRemoveClassesPostDigest(element, options.addClass, options.removeClass);
              }
              return new $$AnimateRunner();
            }
          };
          function addRemoveClassesPostDigest(element, add, remove) {
            var data = postDigestQueue.get(element);
            var classVal;
            if (!data) {
              postDigestQueue.put(element, data = {});
              postDigestElements.push(element);
            }
            if (add) {
              forEach(add.split(' '), function(className) {
                if (className) {
                  data[className] = true;
                }
              });
            }
            if (remove) {
              forEach(remove.split(' '), function(className) {
                if (className) {
                  data[className] = false;
                }
              });
            }
            if (postDigestElements.length > 1)
              return ;
            $rootScope.$$postDigest(function() {
              forEach(postDigestElements, function(element) {
                var data = postDigestQueue.get(element);
                if (data) {
                  var existing = splitClasses(element.attr('class'));
                  var toAdd = '';
                  var toRemove = '';
                  forEach(data, function(status, className) {
                    var hasClass = !!existing[className];
                    if (status !== hasClass) {
                      if (status) {
                        toAdd += (toAdd.length ? ' ' : '') + className;
                      } else {
                        toRemove += (toRemove.length ? ' ' : '') + className;
                      }
                    }
                  });
                  forEach(element, function(elm) {
                    toAdd && jqLiteAddClass(elm, toAdd);
                    toRemove && jqLiteRemoveClass(elm, toRemove);
                  });
                  postDigestQueue.remove(element);
                }
              });
              postDigestElements.length = 0;
            });
          }
        }];
      };
      var $AnimateProvider = ['$provide', function($provide) {
        var provider = this;
        this.$$registeredAnimations = Object.create(null);
        this.register = function(name, factory) {
          if (name && name.charAt(0) !== '.') {
            throw $animateMinErr('notcsel', "Expecting class selector starting with '.' got '{0}'.", name);
          }
          var key = name + '-animation';
          provider.$$registeredAnimations[name.substr(1)] = key;
          $provide.factory(key, factory);
        };
        this.classNameFilter = function(expression) {
          if (arguments.length === 1) {
            this.$$classNameFilter = (expression instanceof RegExp) ? expression : null;
            if (this.$$classNameFilter) {
              var reservedRegex = new RegExp("(\\s+|\\/)" + NG_ANIMATE_CLASSNAME + "(\\s+|\\/)");
              if (reservedRegex.test(this.$$classNameFilter.toString())) {
                throw $animateMinErr('nongcls', '$animateProvider.classNameFilter(regex) prohibits accepting a regex value which matches/contains the "{0}" CSS class.', NG_ANIMATE_CLASSNAME);
              }
            }
          }
          return this.$$classNameFilter;
        };
        this.$get = ['$$animateQueue', function($$animateQueue) {
          function domInsert(element, parentElement, afterElement) {
            if (afterElement) {
              var afterNode = extractElementNode(afterElement);
              if (afterNode && !afterNode.parentNode && !afterNode.previousElementSibling) {
                afterElement = null;
              }
            }
            afterElement ? afterElement.after(element) : parentElement.prepend(element);
          }
          return {
            on: $$animateQueue.on,
            off: $$animateQueue.off,
            pin: $$animateQueue.pin,
            enabled: $$animateQueue.enabled,
            cancel: function(runner) {
              runner.end && runner.end();
            },
            enter: function(element, parent, after, options) {
              parent = parent && jqLite(parent);
              after = after && jqLite(after);
              parent = parent || after.parent();
              domInsert(element, parent, after);
              return $$animateQueue.push(element, 'enter', prepareAnimateOptions(options));
            },
            move: function(element, parent, after, options) {
              parent = parent && jqLite(parent);
              after = after && jqLite(after);
              parent = parent || after.parent();
              domInsert(element, parent, after);
              return $$animateQueue.push(element, 'move', prepareAnimateOptions(options));
            },
            leave: function(element, options) {
              return $$animateQueue.push(element, 'leave', prepareAnimateOptions(options), function() {
                element.remove();
              });
            },
            addClass: function(element, className, options) {
              options = prepareAnimateOptions(options);
              options.addClass = mergeClasses(options.addclass, className);
              return $$animateQueue.push(element, 'addClass', options);
            },
            removeClass: function(element, className, options) {
              options = prepareAnimateOptions(options);
              options.removeClass = mergeClasses(options.removeClass, className);
              return $$animateQueue.push(element, 'removeClass', options);
            },
            setClass: function(element, add, remove, options) {
              options = prepareAnimateOptions(options);
              options.addClass = mergeClasses(options.addClass, add);
              options.removeClass = mergeClasses(options.removeClass, remove);
              return $$animateQueue.push(element, 'setClass', options);
            },
            animate: function(element, from, to, className, options) {
              options = prepareAnimateOptions(options);
              options.from = options.from ? extend(options.from, from) : from;
              options.to = options.to ? extend(options.to, to) : to;
              className = className || 'ng-inline-animate';
              options.tempClasses = mergeClasses(options.tempClasses, className);
              return $$animateQueue.push(element, 'animate', options);
            }
          };
        }];
      }];
      function $$AsyncCallbackProvider() {
        this.$get = ['$$rAF', '$timeout', function($$rAF, $timeout) {
          return $$rAF.supported ? function(fn) {
            return $$rAF(fn);
          } : function(fn) {
            return $timeout(fn, 0, false);
          };
        }];
      }
      function Browser(window, document, $log, $sniffer) {
        var self = this,
            rawDocument = document[0],
            location = window.location,
            history = window.history,
            setTimeout = window.setTimeout,
            clearTimeout = window.clearTimeout,
            pendingDeferIds = {};
        self.isMock = false;
        var outstandingRequestCount = 0;
        var outstandingRequestCallbacks = [];
        self.$$completeOutstandingRequest = completeOutstandingRequest;
        self.$$incOutstandingRequestCount = function() {
          outstandingRequestCount++;
        };
        function completeOutstandingRequest(fn) {
          try {
            fn.apply(null, sliceArgs(arguments, 1));
          } finally {
            outstandingRequestCount--;
            if (outstandingRequestCount === 0) {
              while (outstandingRequestCallbacks.length) {
                try {
                  outstandingRequestCallbacks.pop()();
                } catch (e) {
                  $log.error(e);
                }
              }
            }
          }
        }
        function getHash(url) {
          var index = url.indexOf('#');
          return index === -1 ? '' : url.substr(index + 1);
        }
        self.notifyWhenNoOutstandingRequests = function(callback) {
          if (outstandingRequestCount === 0) {
            callback();
          } else {
            outstandingRequestCallbacks.push(callback);
          }
        };
        var cachedState,
            lastHistoryState,
            lastBrowserUrl = location.href,
            baseElement = document.find('base'),
            reloadLocation = null;
        cacheState();
        lastHistoryState = cachedState;
        self.url = function(url, replace, state) {
          if (isUndefined(state)) {
            state = null;
          }
          if (location !== window.location)
            location = window.location;
          if (history !== window.history)
            history = window.history;
          if (url) {
            var sameState = lastHistoryState === state;
            if (lastBrowserUrl === url && (!$sniffer.history || sameState)) {
              return self;
            }
            var sameBase = lastBrowserUrl && stripHash(lastBrowserUrl) === stripHash(url);
            lastBrowserUrl = url;
            lastHistoryState = state;
            if ($sniffer.history && (!sameBase || !sameState)) {
              history[replace ? 'replaceState' : 'pushState'](state, '', url);
              cacheState();
              lastHistoryState = cachedState;
            } else {
              if (!sameBase || reloadLocation) {
                reloadLocation = url;
              }
              if (replace) {
                location.replace(url);
              } else if (!sameBase) {
                location.href = url;
              } else {
                location.hash = getHash(url);
              }
            }
            return self;
          } else {
            return reloadLocation || location.href.replace(/%27/g, "'");
          }
        };
        self.state = function() {
          return cachedState;
        };
        var urlChangeListeners = [],
            urlChangeInit = false;
        function cacheStateAndFireUrlChange() {
          cacheState();
          fireUrlChange();
        }
        function getCurrentState() {
          try {
            return history.state;
          } catch (e) {}
        }
        var lastCachedState = null;
        function cacheState() {
          cachedState = getCurrentState();
          cachedState = isUndefined(cachedState) ? null : cachedState;
          if (equals(cachedState, lastCachedState)) {
            cachedState = lastCachedState;
          }
          lastCachedState = cachedState;
        }
        function fireUrlChange() {
          if (lastBrowserUrl === self.url() && lastHistoryState === cachedState) {
            return ;
          }
          lastBrowserUrl = self.url();
          lastHistoryState = cachedState;
          forEach(urlChangeListeners, function(listener) {
            listener(self.url(), cachedState);
          });
        }
        self.onUrlChange = function(callback) {
          if (!urlChangeInit) {
            if ($sniffer.history)
              jqLite(window).on('popstate', cacheStateAndFireUrlChange);
            jqLite(window).on('hashchange', cacheStateAndFireUrlChange);
            urlChangeInit = true;
          }
          urlChangeListeners.push(callback);
          return callback;
        };
        self.$$applicationDestroyed = function() {
          jqLite(window).off('hashchange popstate', cacheStateAndFireUrlChange);
        };
        self.$$checkUrlChange = fireUrlChange;
        self.baseHref = function() {
          var href = baseElement.attr('href');
          return href ? href.replace(/^(https?\:)?\/\/[^\/]*/, '') : '';
        };
        self.defer = function(fn, delay) {
          var timeoutId;
          outstandingRequestCount++;
          timeoutId = setTimeout(function() {
            delete pendingDeferIds[timeoutId];
            completeOutstandingRequest(fn);
          }, delay || 0);
          pendingDeferIds[timeoutId] = true;
          return timeoutId;
        };
        self.defer.cancel = function(deferId) {
          if (pendingDeferIds[deferId]) {
            delete pendingDeferIds[deferId];
            clearTimeout(deferId);
            completeOutstandingRequest(noop);
            return true;
          }
          return false;
        };
      }
      function $BrowserProvider() {
        this.$get = ['$window', '$log', '$sniffer', '$document', function($window, $log, $sniffer, $document) {
          return new Browser($window, $document, $log, $sniffer);
        }];
      }
      function $CacheFactoryProvider() {
        this.$get = function() {
          var caches = {};
          function cacheFactory(cacheId, options) {
            if (cacheId in caches) {
              throw minErr('$cacheFactory')('iid', "CacheId '{0}' is already taken!", cacheId);
            }
            var size = 0,
                stats = extend({}, options, {id: cacheId}),
                data = {},
                capacity = (options && options.capacity) || Number.MAX_VALUE,
                lruHash = {},
                freshEnd = null,
                staleEnd = null;
            return caches[cacheId] = {
              put: function(key, value) {
                if (isUndefined(value))
                  return ;
                if (capacity < Number.MAX_VALUE) {
                  var lruEntry = lruHash[key] || (lruHash[key] = {key: key});
                  refresh(lruEntry);
                }
                if (!(key in data))
                  size++;
                data[key] = value;
                if (size > capacity) {
                  this.remove(staleEnd.key);
                }
                return value;
              },
              get: function(key) {
                if (capacity < Number.MAX_VALUE) {
                  var lruEntry = lruHash[key];
                  if (!lruEntry)
                    return ;
                  refresh(lruEntry);
                }
                return data[key];
              },
              remove: function(key) {
                if (capacity < Number.MAX_VALUE) {
                  var lruEntry = lruHash[key];
                  if (!lruEntry)
                    return ;
                  if (lruEntry == freshEnd)
                    freshEnd = lruEntry.p;
                  if (lruEntry == staleEnd)
                    staleEnd = lruEntry.n;
                  link(lruEntry.n, lruEntry.p);
                  delete lruHash[key];
                }
                delete data[key];
                size--;
              },
              removeAll: function() {
                data = {};
                size = 0;
                lruHash = {};
                freshEnd = staleEnd = null;
              },
              destroy: function() {
                data = null;
                stats = null;
                lruHash = null;
                delete caches[cacheId];
              },
              info: function() {
                return extend({}, stats, {size: size});
              }
            };
            function refresh(entry) {
              if (entry != freshEnd) {
                if (!staleEnd) {
                  staleEnd = entry;
                } else if (staleEnd == entry) {
                  staleEnd = entry.n;
                }
                link(entry.n, entry.p);
                link(entry, freshEnd);
                freshEnd = entry;
                freshEnd.n = null;
              }
            }
            function link(nextEntry, prevEntry) {
              if (nextEntry != prevEntry) {
                if (nextEntry)
                  nextEntry.p = prevEntry;
                if (prevEntry)
                  prevEntry.n = nextEntry;
              }
            }
          }
          cacheFactory.info = function() {
            var info = {};
            forEach(caches, function(cache, cacheId) {
              info[cacheId] = cache.info();
            });
            return info;
          };
          cacheFactory.get = function(cacheId) {
            return caches[cacheId];
          };
          return cacheFactory;
        };
      }
      function $TemplateCacheProvider() {
        this.$get = ['$cacheFactory', function($cacheFactory) {
          return $cacheFactory('templates');
        }];
      }
      var $compileMinErr = minErr('$compile');
      $CompileProvider.$inject = ['$provide', '$$sanitizeUriProvider'];
      function $CompileProvider($provide, $$sanitizeUriProvider) {
        var hasDirectives = {},
            Suffix = 'Directive',
            COMMENT_DIRECTIVE_REGEXP = /^\s*directive\:\s*([\w\-]+)\s+(.*)$/,
            CLASS_DIRECTIVE_REGEXP = /(([\w\-]+)(?:\:([^;]+))?;?)/,
            ALL_OR_NOTHING_ATTRS = makeMap('ngSrc,ngSrcset,src,srcset'),
            REQUIRE_PREFIX_REGEXP = /^(?:(\^\^?)?(\?)?(\^\^?)?)?/;
        var EVENT_HANDLER_ATTR_REGEXP = /^(on[a-z]+|formaction)$/;
        function parseIsolateBindings(scope, directiveName, isController) {
          var LOCAL_REGEXP = /^\s*([@&]|=(\*?))(\??)\s*(\w*)\s*$/;
          var bindings = {};
          forEach(scope, function(definition, scopeName) {
            var match = definition.match(LOCAL_REGEXP);
            if (!match) {
              throw $compileMinErr('iscp', "Invalid {3} for directive '{0}'." + " Definition: {... {1}: '{2}' ...}", directiveName, scopeName, definition, (isController ? "controller bindings definition" : "isolate scope definition"));
            }
            bindings[scopeName] = {
              mode: match[1][0],
              collection: match[2] === '*',
              optional: match[3] === '?',
              attrName: match[4] || scopeName
            };
          });
          return bindings;
        }
        function parseDirectiveBindings(directive, directiveName) {
          var bindings = {
            isolateScope: null,
            bindToController: null
          };
          if (isObject(directive.scope)) {
            if (directive.bindToController === true) {
              bindings.bindToController = parseIsolateBindings(directive.scope, directiveName, true);
              bindings.isolateScope = {};
            } else {
              bindings.isolateScope = parseIsolateBindings(directive.scope, directiveName, false);
            }
          }
          if (isObject(directive.bindToController)) {
            bindings.bindToController = parseIsolateBindings(directive.bindToController, directiveName, true);
          }
          if (isObject(bindings.bindToController)) {
            var controller = directive.controller;
            var controllerAs = directive.controllerAs;
            if (!controller) {
              throw $compileMinErr('noctrl', "Cannot bind to controller without directive '{0}'s controller.", directiveName);
            } else if (!identifierForController(controller, controllerAs)) {
              throw $compileMinErr('noident', "Cannot bind to controller without identifier for directive '{0}'.", directiveName);
            }
          }
          return bindings;
        }
        function assertValidDirectiveName(name) {
          var letter = name.charAt(0);
          if (!letter || letter !== lowercase(letter)) {
            throw $compileMinErr('baddir', "Directive name '{0}' is invalid. The first character must be a lowercase letter", name);
          }
          if (name !== name.trim()) {
            throw $compileMinErr('baddir', "Directive name '{0}' is invalid. The name should not contain leading or trailing whitespaces", name);
          }
        }
        this.directive = function registerDirective(name, directiveFactory) {
          assertNotHasOwnProperty(name, 'directive');
          if (isString(name)) {
            assertValidDirectiveName(name);
            assertArg(directiveFactory, 'directiveFactory');
            if (!hasDirectives.hasOwnProperty(name)) {
              hasDirectives[name] = [];
              $provide.factory(name + Suffix, ['$injector', '$exceptionHandler', function($injector, $exceptionHandler) {
                var directives = [];
                forEach(hasDirectives[name], function(directiveFactory, index) {
                  try {
                    var directive = $injector.invoke(directiveFactory);
                    if (isFunction(directive)) {
                      directive = {compile: valueFn(directive)};
                    } else if (!directive.compile && directive.link) {
                      directive.compile = valueFn(directive.link);
                    }
                    directive.priority = directive.priority || 0;
                    directive.index = index;
                    directive.name = directive.name || name;
                    directive.require = directive.require || (directive.controller && directive.name);
                    directive.restrict = directive.restrict || 'EA';
                    var bindings = directive.$$bindings = parseDirectiveBindings(directive, directive.name);
                    if (isObject(bindings.isolateScope)) {
                      directive.$$isolateBindings = bindings.isolateScope;
                    }
                    directive.$$moduleName = directiveFactory.$$moduleName;
                    directives.push(directive);
                  } catch (e) {
                    $exceptionHandler(e);
                  }
                });
                return directives;
              }]);
            }
            hasDirectives[name].push(directiveFactory);
          } else {
            forEach(name, reverseParams(registerDirective));
          }
          return this;
        };
        this.aHrefSanitizationWhitelist = function(regexp) {
          if (isDefined(regexp)) {
            $$sanitizeUriProvider.aHrefSanitizationWhitelist(regexp);
            return this;
          } else {
            return $$sanitizeUriProvider.aHrefSanitizationWhitelist();
          }
        };
        this.imgSrcSanitizationWhitelist = function(regexp) {
          if (isDefined(regexp)) {
            $$sanitizeUriProvider.imgSrcSanitizationWhitelist(regexp);
            return this;
          } else {
            return $$sanitizeUriProvider.imgSrcSanitizationWhitelist();
          }
        };
        var debugInfoEnabled = true;
        this.debugInfoEnabled = function(enabled) {
          if (isDefined(enabled)) {
            debugInfoEnabled = enabled;
            return this;
          }
          return debugInfoEnabled;
        };
        this.$get = ['$injector', '$interpolate', '$exceptionHandler', '$templateRequest', '$parse', '$controller', '$rootScope', '$document', '$sce', '$animate', '$$sanitizeUri', function($injector, $interpolate, $exceptionHandler, $templateRequest, $parse, $controller, $rootScope, $document, $sce, $animate, $$sanitizeUri) {
          var Attributes = function(element, attributesToCopy) {
            if (attributesToCopy) {
              var keys = Object.keys(attributesToCopy);
              var i,
                  l,
                  key;
              for (i = 0, l = keys.length; i < l; i++) {
                key = keys[i];
                this[key] = attributesToCopy[key];
              }
            } else {
              this.$attr = {};
            }
            this.$$element = element;
          };
          Attributes.prototype = {
            $normalize: directiveNormalize,
            $addClass: function(classVal) {
              if (classVal && classVal.length > 0) {
                $animate.addClass(this.$$element, classVal);
              }
            },
            $removeClass: function(classVal) {
              if (classVal && classVal.length > 0) {
                $animate.removeClass(this.$$element, classVal);
              }
            },
            $updateClass: function(newClasses, oldClasses) {
              var toAdd = tokenDifference(newClasses, oldClasses);
              if (toAdd && toAdd.length) {
                $animate.addClass(this.$$element, toAdd);
              }
              var toRemove = tokenDifference(oldClasses, newClasses);
              if (toRemove && toRemove.length) {
                $animate.removeClass(this.$$element, toRemove);
              }
            },
            $set: function(key, value, writeAttr, attrName) {
              var node = this.$$element[0],
                  booleanKey = getBooleanAttrName(node, key),
                  aliasedKey = getAliasedAttrName(node, key),
                  observer = key,
                  nodeName;
              if (booleanKey) {
                this.$$element.prop(key, value);
                attrName = booleanKey;
              } else if (aliasedKey) {
                this[aliasedKey] = value;
                observer = aliasedKey;
              }
              this[key] = value;
              if (attrName) {
                this.$attr[key] = attrName;
              } else {
                attrName = this.$attr[key];
                if (!attrName) {
                  this.$attr[key] = attrName = snake_case(key, '-');
                }
              }
              nodeName = nodeName_(this.$$element);
              if ((nodeName === 'a' && key === 'href') || (nodeName === 'img' && key === 'src')) {
                this[key] = value = $$sanitizeUri(value, key === 'src');
              } else if (nodeName === 'img' && key === 'srcset') {
                var result = "";
                var trimmedSrcset = trim(value);
                var srcPattern = /(\s+\d+x\s*,|\s+\d+w\s*,|\s+,|,\s+)/;
                var pattern = /\s/.test(trimmedSrcset) ? srcPattern : /(,)/;
                var rawUris = trimmedSrcset.split(pattern);
                var nbrUrisWith2parts = Math.floor(rawUris.length / 2);
                for (var i = 0; i < nbrUrisWith2parts; i++) {
                  var innerIdx = i * 2;
                  result += $$sanitizeUri(trim(rawUris[innerIdx]), true);
                  result += (" " + trim(rawUris[innerIdx + 1]));
                }
                var lastTuple = trim(rawUris[i * 2]).split(/\s/);
                result += $$sanitizeUri(trim(lastTuple[0]), true);
                if (lastTuple.length === 2) {
                  result += (" " + trim(lastTuple[1]));
                }
                this[key] = value = result;
              }
              if (writeAttr !== false) {
                if (value === null || value === undefined) {
                  this.$$element.removeAttr(attrName);
                } else {
                  this.$$element.attr(attrName, value);
                }
              }
              var $$observers = this.$$observers;
              $$observers && forEach($$observers[observer], function(fn) {
                try {
                  fn(value);
                } catch (e) {
                  $exceptionHandler(e);
                }
              });
            },
            $observe: function(key, fn) {
              var attrs = this,
                  $$observers = (attrs.$$observers || (attrs.$$observers = createMap())),
                  listeners = ($$observers[key] || ($$observers[key] = []));
              listeners.push(fn);
              $rootScope.$evalAsync(function() {
                if (!listeners.$$inter && attrs.hasOwnProperty(key)) {
                  fn(attrs[key]);
                }
              });
              return function() {
                arrayRemove(listeners, fn);
              };
            }
          };
          function safeAddClass($element, className) {
            try {
              $element.addClass(className);
            } catch (e) {}
          }
          var startSymbol = $interpolate.startSymbol(),
              endSymbol = $interpolate.endSymbol(),
              denormalizeTemplate = (startSymbol == '{{' || endSymbol == '}}') ? identity : function denormalizeTemplate(template) {
                return template.replace(/\{\{/g, startSymbol).replace(/}}/g, endSymbol);
              },
              NG_ATTR_BINDING = /^ngAttr[A-Z]/;
          compile.$$addBindingInfo = debugInfoEnabled ? function $$addBindingInfo($element, binding) {
            var bindings = $element.data('$binding') || [];
            if (isArray(binding)) {
              bindings = bindings.concat(binding);
            } else {
              bindings.push(binding);
            }
            $element.data('$binding', bindings);
          } : noop;
          compile.$$addBindingClass = debugInfoEnabled ? function $$addBindingClass($element) {
            safeAddClass($element, 'ng-binding');
          } : noop;
          compile.$$addScopeInfo = debugInfoEnabled ? function $$addScopeInfo($element, scope, isolated, noTemplate) {
            var dataName = isolated ? (noTemplate ? '$isolateScopeNoTemplate' : '$isolateScope') : '$scope';
            $element.data(dataName, scope);
          } : noop;
          compile.$$addScopeClass = debugInfoEnabled ? function $$addScopeClass($element, isolated) {
            safeAddClass($element, isolated ? 'ng-isolate-scope' : 'ng-scope');
          } : noop;
          return compile;
          function compile($compileNodes, transcludeFn, maxPriority, ignoreDirective, previousCompileContext) {
            if (!($compileNodes instanceof jqLite)) {
              $compileNodes = jqLite($compileNodes);
            }
            forEach($compileNodes, function(node, index) {
              if (node.nodeType == NODE_TYPE_TEXT && node.nodeValue.match(/\S+/)) {
                $compileNodes[index] = jqLite(node).wrap('<span></span>').parent()[0];
              }
            });
            var compositeLinkFn = compileNodes($compileNodes, transcludeFn, $compileNodes, maxPriority, ignoreDirective, previousCompileContext);
            compile.$$addScopeClass($compileNodes);
            var namespace = null;
            return function publicLinkFn(scope, cloneConnectFn, options) {
              assertArg(scope, 'scope');
              options = options || {};
              var parentBoundTranscludeFn = options.parentBoundTranscludeFn,
                  transcludeControllers = options.transcludeControllers,
                  futureParentElement = options.futureParentElement;
              if (parentBoundTranscludeFn && parentBoundTranscludeFn.$$boundTransclude) {
                parentBoundTranscludeFn = parentBoundTranscludeFn.$$boundTransclude;
              }
              if (!namespace) {
                namespace = detectNamespaceForChildElements(futureParentElement);
              }
              var $linkNode;
              if (namespace !== 'html') {
                $linkNode = jqLite(wrapTemplate(namespace, jqLite('<div>').append($compileNodes).html()));
              } else if (cloneConnectFn) {
                $linkNode = JQLitePrototype.clone.call($compileNodes);
              } else {
                $linkNode = $compileNodes;
              }
              if (transcludeControllers) {
                for (var controllerName in transcludeControllers) {
                  $linkNode.data('$' + controllerName + 'Controller', transcludeControllers[controllerName].instance);
                }
              }
              compile.$$addScopeInfo($linkNode, scope);
              if (cloneConnectFn)
                cloneConnectFn($linkNode, scope);
              if (compositeLinkFn)
                compositeLinkFn(scope, $linkNode, $linkNode, parentBoundTranscludeFn);
              return $linkNode;
            };
          }
          function detectNamespaceForChildElements(parentElement) {
            var node = parentElement && parentElement[0];
            if (!node) {
              return 'html';
            } else {
              return nodeName_(node) !== 'foreignobject' && node.toString().match(/SVG/) ? 'svg' : 'html';
            }
          }
          function compileNodes(nodeList, transcludeFn, $rootElement, maxPriority, ignoreDirective, previousCompileContext) {
            var linkFns = [],
                attrs,
                directives,
                nodeLinkFn,
                childNodes,
                childLinkFn,
                linkFnFound,
                nodeLinkFnFound;
            for (var i = 0; i < nodeList.length; i++) {
              attrs = new Attributes();
              directives = collectDirectives(nodeList[i], [], attrs, i === 0 ? maxPriority : undefined, ignoreDirective);
              nodeLinkFn = (directives.length) ? applyDirectivesToNode(directives, nodeList[i], attrs, transcludeFn, $rootElement, null, [], [], previousCompileContext) : null;
              if (nodeLinkFn && nodeLinkFn.scope) {
                compile.$$addScopeClass(attrs.$$element);
              }
              childLinkFn = (nodeLinkFn && nodeLinkFn.terminal || !(childNodes = nodeList[i].childNodes) || !childNodes.length) ? null : compileNodes(childNodes, nodeLinkFn ? ((nodeLinkFn.transcludeOnThisElement || !nodeLinkFn.templateOnThisElement) && nodeLinkFn.transclude) : transcludeFn);
              if (nodeLinkFn || childLinkFn) {
                linkFns.push(i, nodeLinkFn, childLinkFn);
                linkFnFound = true;
                nodeLinkFnFound = nodeLinkFnFound || nodeLinkFn;
              }
              previousCompileContext = null;
            }
            return linkFnFound ? compositeLinkFn : null;
            function compositeLinkFn(scope, nodeList, $rootElement, parentBoundTranscludeFn) {
              var nodeLinkFn,
                  childLinkFn,
                  node,
                  childScope,
                  i,
                  ii,
                  idx,
                  childBoundTranscludeFn;
              var stableNodeList;
              if (nodeLinkFnFound) {
                var nodeListLength = nodeList.length;
                stableNodeList = new Array(nodeListLength);
                for (i = 0; i < linkFns.length; i += 3) {
                  idx = linkFns[i];
                  stableNodeList[idx] = nodeList[idx];
                }
              } else {
                stableNodeList = nodeList;
              }
              for (i = 0, ii = linkFns.length; i < ii; ) {
                node = stableNodeList[linkFns[i++]];
                nodeLinkFn = linkFns[i++];
                childLinkFn = linkFns[i++];
                if (nodeLinkFn) {
                  if (nodeLinkFn.scope) {
                    childScope = scope.$new();
                    compile.$$addScopeInfo(jqLite(node), childScope);
                    var destroyBindings = nodeLinkFn.$$destroyBindings;
                    if (destroyBindings) {
                      nodeLinkFn.$$destroyBindings = null;
                      childScope.$on('$destroyed', destroyBindings);
                    }
                  } else {
                    childScope = scope;
                  }
                  if (nodeLinkFn.transcludeOnThisElement) {
                    childBoundTranscludeFn = createBoundTranscludeFn(scope, nodeLinkFn.transclude, parentBoundTranscludeFn);
                  } else if (!nodeLinkFn.templateOnThisElement && parentBoundTranscludeFn) {
                    childBoundTranscludeFn = parentBoundTranscludeFn;
                  } else if (!parentBoundTranscludeFn && transcludeFn) {
                    childBoundTranscludeFn = createBoundTranscludeFn(scope, transcludeFn);
                  } else {
                    childBoundTranscludeFn = null;
                  }
                  nodeLinkFn(childLinkFn, childScope, node, $rootElement, childBoundTranscludeFn, nodeLinkFn);
                } else if (childLinkFn) {
                  childLinkFn(scope, node.childNodes, undefined, parentBoundTranscludeFn);
                }
              }
            }
          }
          function createBoundTranscludeFn(scope, transcludeFn, previousBoundTranscludeFn) {
            var boundTranscludeFn = function(transcludedScope, cloneFn, controllers, futureParentElement, containingScope) {
              if (!transcludedScope) {
                transcludedScope = scope.$new(false, containingScope);
                transcludedScope.$$transcluded = true;
              }
              return transcludeFn(transcludedScope, cloneFn, {
                parentBoundTranscludeFn: previousBoundTranscludeFn,
                transcludeControllers: controllers,
                futureParentElement: futureParentElement
              });
            };
            return boundTranscludeFn;
          }
          function collectDirectives(node, directives, attrs, maxPriority, ignoreDirective) {
            var nodeType = node.nodeType,
                attrsMap = attrs.$attr,
                match,
                className;
            switch (nodeType) {
              case NODE_TYPE_ELEMENT:
                addDirective(directives, directiveNormalize(nodeName_(node)), 'E', maxPriority, ignoreDirective);
                for (var attr,
                    name,
                    nName,
                    ngAttrName,
                    value,
                    isNgAttr,
                    nAttrs = node.attributes,
                    j = 0,
                    jj = nAttrs && nAttrs.length; j < jj; j++) {
                  var attrStartName = false;
                  var attrEndName = false;
                  attr = nAttrs[j];
                  name = attr.name;
                  value = trim(attr.value);
                  ngAttrName = directiveNormalize(name);
                  if (isNgAttr = NG_ATTR_BINDING.test(ngAttrName)) {
                    name = name.replace(PREFIX_REGEXP, '').substr(8).replace(/_(.)/g, function(match, letter) {
                      return letter.toUpperCase();
                    });
                  }
                  var directiveNName = ngAttrName.replace(/(Start|End)$/, '');
                  if (directiveIsMultiElement(directiveNName)) {
                    if (ngAttrName === directiveNName + 'Start') {
                      attrStartName = name;
                      attrEndName = name.substr(0, name.length - 5) + 'end';
                      name = name.substr(0, name.length - 6);
                    }
                  }
                  nName = directiveNormalize(name.toLowerCase());
                  attrsMap[nName] = name;
                  if (isNgAttr || !attrs.hasOwnProperty(nName)) {
                    attrs[nName] = value;
                    if (getBooleanAttrName(node, nName)) {
                      attrs[nName] = true;
                    }
                  }
                  addAttrInterpolateDirective(node, directives, value, nName, isNgAttr);
                  addDirective(directives, nName, 'A', maxPriority, ignoreDirective, attrStartName, attrEndName);
                }
                className = node.className;
                if (isObject(className)) {
                  className = className.animVal;
                }
                if (isString(className) && className !== '') {
                  while (match = CLASS_DIRECTIVE_REGEXP.exec(className)) {
                    nName = directiveNormalize(match[2]);
                    if (addDirective(directives, nName, 'C', maxPriority, ignoreDirective)) {
                      attrs[nName] = trim(match[3]);
                    }
                    className = className.substr(match.index + match[0].length);
                  }
                }
                break;
              case NODE_TYPE_TEXT:
                if (msie === 11) {
                  while (node.parentNode && node.nextSibling && node.nextSibling.nodeType === NODE_TYPE_TEXT) {
                    node.nodeValue = node.nodeValue + node.nextSibling.nodeValue;
                    node.parentNode.removeChild(node.nextSibling);
                  }
                }
                addTextInterpolateDirective(directives, node.nodeValue);
                break;
              case NODE_TYPE_COMMENT:
                try {
                  match = COMMENT_DIRECTIVE_REGEXP.exec(node.nodeValue);
                  if (match) {
                    nName = directiveNormalize(match[1]);
                    if (addDirective(directives, nName, 'M', maxPriority, ignoreDirective)) {
                      attrs[nName] = trim(match[2]);
                    }
                  }
                } catch (e) {}
                break;
            }
            directives.sort(byPriority);
            return directives;
          }
          function groupScan(node, attrStart, attrEnd) {
            var nodes = [];
            var depth = 0;
            if (attrStart && node.hasAttribute && node.hasAttribute(attrStart)) {
              do {
                if (!node) {
                  throw $compileMinErr('uterdir', "Unterminated attribute, found '{0}' but no matching '{1}' found.", attrStart, attrEnd);
                }
                if (node.nodeType == NODE_TYPE_ELEMENT) {
                  if (node.hasAttribute(attrStart))
                    depth++;
                  if (node.hasAttribute(attrEnd))
                    depth--;
                }
                nodes.push(node);
                node = node.nextSibling;
              } while (depth > 0);
            } else {
              nodes.push(node);
            }
            return jqLite(nodes);
          }
          function groupElementsLinkFnWrapper(linkFn, attrStart, attrEnd) {
            return function(scope, element, attrs, controllers, transcludeFn) {
              element = groupScan(element[0], attrStart, attrEnd);
              return linkFn(scope, element, attrs, controllers, transcludeFn);
            };
          }
          function applyDirectivesToNode(directives, compileNode, templateAttrs, transcludeFn, jqCollection, originalReplaceDirective, preLinkFns, postLinkFns, previousCompileContext) {
            previousCompileContext = previousCompileContext || {};
            var terminalPriority = -Number.MAX_VALUE,
                newScopeDirective,
                controllerDirectives = previousCompileContext.controllerDirectives,
                newIsolateScopeDirective = previousCompileContext.newIsolateScopeDirective,
                templateDirective = previousCompileContext.templateDirective,
                nonTlbTranscludeDirective = previousCompileContext.nonTlbTranscludeDirective,
                hasTranscludeDirective = false,
                hasTemplate = false,
                hasElementTranscludeDirective = previousCompileContext.hasElementTranscludeDirective,
                $compileNode = templateAttrs.$$element = jqLite(compileNode),
                directive,
                directiveName,
                $template,
                replaceDirective = originalReplaceDirective,
                childTranscludeFn = transcludeFn,
                linkFn,
                directiveValue;
            for (var i = 0,
                ii = directives.length; i < ii; i++) {
              directive = directives[i];
              var attrStart = directive.$$start;
              var attrEnd = directive.$$end;
              if (attrStart) {
                $compileNode = groupScan(compileNode, attrStart, attrEnd);
              }
              $template = undefined;
              if (terminalPriority > directive.priority) {
                break;
              }
              if (directiveValue = directive.scope) {
                if (!directive.templateUrl) {
                  if (isObject(directiveValue)) {
                    assertNoDuplicate('new/isolated scope', newIsolateScopeDirective || newScopeDirective, directive, $compileNode);
                    newIsolateScopeDirective = directive;
                  } else {
                    assertNoDuplicate('new/isolated scope', newIsolateScopeDirective, directive, $compileNode);
                  }
                }
                newScopeDirective = newScopeDirective || directive;
              }
              directiveName = directive.name;
              if (!directive.templateUrl && directive.controller) {
                directiveValue = directive.controller;
                controllerDirectives = controllerDirectives || createMap();
                assertNoDuplicate("'" + directiveName + "' controller", controllerDirectives[directiveName], directive, $compileNode);
                controllerDirectives[directiveName] = directive;
              }
              if (directiveValue = directive.transclude) {
                hasTranscludeDirective = true;
                if (!directive.$$tlb) {
                  assertNoDuplicate('transclusion', nonTlbTranscludeDirective, directive, $compileNode);
                  nonTlbTranscludeDirective = directive;
                }
                if (directiveValue == 'element') {
                  hasElementTranscludeDirective = true;
                  terminalPriority = directive.priority;
                  $template = $compileNode;
                  $compileNode = templateAttrs.$$element = jqLite(document.createComment(' ' + directiveName + ': ' + templateAttrs[directiveName] + ' '));
                  compileNode = $compileNode[0];
                  replaceWith(jqCollection, sliceArgs($template), compileNode);
                  childTranscludeFn = compile($template, transcludeFn, terminalPriority, replaceDirective && replaceDirective.name, {nonTlbTranscludeDirective: nonTlbTranscludeDirective});
                } else {
                  $template = jqLite(jqLiteClone(compileNode)).contents();
                  $compileNode.empty();
                  childTranscludeFn = compile($template, transcludeFn);
                }
              }
              if (directive.template) {
                hasTemplate = true;
                assertNoDuplicate('template', templateDirective, directive, $compileNode);
                templateDirective = directive;
                directiveValue = (isFunction(directive.template)) ? directive.template($compileNode, templateAttrs) : directive.template;
                directiveValue = denormalizeTemplate(directiveValue);
                if (directive.replace) {
                  replaceDirective = directive;
                  if (jqLiteIsTextNode(directiveValue)) {
                    $template = [];
                  } else {
                    $template = removeComments(wrapTemplate(directive.templateNamespace, trim(directiveValue)));
                  }
                  compileNode = $template[0];
                  if ($template.length != 1 || compileNode.nodeType !== NODE_TYPE_ELEMENT) {
                    throw $compileMinErr('tplrt', "Template for directive '{0}' must have exactly one root element. {1}", directiveName, '');
                  }
                  replaceWith(jqCollection, $compileNode, compileNode);
                  var newTemplateAttrs = {$attr: {}};
                  var templateDirectives = collectDirectives(compileNode, [], newTemplateAttrs);
                  var unprocessedDirectives = directives.splice(i + 1, directives.length - (i + 1));
                  if (newIsolateScopeDirective) {
                    markDirectivesAsIsolate(templateDirectives);
                  }
                  directives = directives.concat(templateDirectives).concat(unprocessedDirectives);
                  mergeTemplateAttributes(templateAttrs, newTemplateAttrs);
                  ii = directives.length;
                } else {
                  $compileNode.html(directiveValue);
                }
              }
              if (directive.templateUrl) {
                hasTemplate = true;
                assertNoDuplicate('template', templateDirective, directive, $compileNode);
                templateDirective = directive;
                if (directive.replace) {
                  replaceDirective = directive;
                }
                nodeLinkFn = compileTemplateUrl(directives.splice(i, directives.length - i), $compileNode, templateAttrs, jqCollection, hasTranscludeDirective && childTranscludeFn, preLinkFns, postLinkFns, {
                  controllerDirectives: controllerDirectives,
                  newIsolateScopeDirective: newIsolateScopeDirective,
                  templateDirective: templateDirective,
                  nonTlbTranscludeDirective: nonTlbTranscludeDirective
                });
                ii = directives.length;
              } else if (directive.compile) {
                try {
                  linkFn = directive.compile($compileNode, templateAttrs, childTranscludeFn);
                  if (isFunction(linkFn)) {
                    addLinkFns(null, linkFn, attrStart, attrEnd);
                  } else if (linkFn) {
                    addLinkFns(linkFn.pre, linkFn.post, attrStart, attrEnd);
                  }
                } catch (e) {
                  $exceptionHandler(e, startingTag($compileNode));
                }
              }
              if (directive.terminal) {
                nodeLinkFn.terminal = true;
                terminalPriority = Math.max(terminalPriority, directive.priority);
              }
            }
            nodeLinkFn.scope = newScopeDirective && newScopeDirective.scope === true;
            nodeLinkFn.transcludeOnThisElement = hasTranscludeDirective;
            nodeLinkFn.templateOnThisElement = hasTemplate;
            nodeLinkFn.transclude = childTranscludeFn;
            previousCompileContext.hasElementTranscludeDirective = hasElementTranscludeDirective;
            return nodeLinkFn;
            function addLinkFns(pre, post, attrStart, attrEnd) {
              if (pre) {
                if (attrStart)
                  pre = groupElementsLinkFnWrapper(pre, attrStart, attrEnd);
                pre.require = directive.require;
                pre.directiveName = directiveName;
                if (newIsolateScopeDirective === directive || directive.$$isolateScope) {
                  pre = cloneAndAnnotateFn(pre, {isolateScope: true});
                }
                preLinkFns.push(pre);
              }
              if (post) {
                if (attrStart)
                  post = groupElementsLinkFnWrapper(post, attrStart, attrEnd);
                post.require = directive.require;
                post.directiveName = directiveName;
                if (newIsolateScopeDirective === directive || directive.$$isolateScope) {
                  post = cloneAndAnnotateFn(post, {isolateScope: true});
                }
                postLinkFns.push(post);
              }
            }
            function getControllers(directiveName, require, $element, elementControllers) {
              var value;
              if (isString(require)) {
                var match = require.match(REQUIRE_PREFIX_REGEXP);
                var name = require.substring(match[0].length);
                var inheritType = match[1] || match[3];
                var optional = match[2] === '?';
                if (inheritType === '^^') {
                  $element = $element.parent();
                } else {
                  value = elementControllers && elementControllers[name];
                  value = value && value.instance;
                }
                if (!value) {
                  var dataName = '$' + name + 'Controller';
                  value = inheritType ? $element.inheritedData(dataName) : $element.data(dataName);
                }
                if (!value && !optional) {
                  throw $compileMinErr('ctreq', "Controller '{0}', required by directive '{1}', can't be found!", name, directiveName);
                }
              } else if (isArray(require)) {
                value = [];
                for (var i = 0,
                    ii = require.length; i < ii; i++) {
                  value[i] = getControllers(directiveName, require[i], $element, elementControllers);
                }
              }
              return value || null;
            }
            function setupControllers($element, attrs, transcludeFn, controllerDirectives, isolateScope, scope) {
              var elementControllers = createMap();
              for (var controllerKey in controllerDirectives) {
                var directive = controllerDirectives[controllerKey];
                var locals = {
                  $scope: directive === newIsolateScopeDirective || directive.$$isolateScope ? isolateScope : scope,
                  $element: $element,
                  $attrs: attrs,
                  $transclude: transcludeFn
                };
                var controller = directive.controller;
                if (controller == '@') {
                  controller = attrs[directive.name];
                }
                var controllerInstance = $controller(controller, locals, true, directive.controllerAs);
                elementControllers[directive.name] = controllerInstance;
                if (!hasElementTranscludeDirective) {
                  $element.data('$' + directive.name + 'Controller', controllerInstance.instance);
                }
              }
              return elementControllers;
            }
            function nodeLinkFn(childLinkFn, scope, linkNode, $rootElement, boundTranscludeFn, thisLinkFn) {
              var i,
                  ii,
                  linkFn,
                  controller,
                  isolateScope,
                  elementControllers,
                  transcludeFn,
                  $element,
                  attrs;
              if (compileNode === linkNode) {
                attrs = templateAttrs;
                $element = templateAttrs.$$element;
              } else {
                $element = jqLite(linkNode);
                attrs = new Attributes($element, templateAttrs);
              }
              if (newIsolateScopeDirective) {
                isolateScope = scope.$new(true);
              }
              if (boundTranscludeFn) {
                transcludeFn = controllersBoundTransclude;
                transcludeFn.$$boundTransclude = boundTranscludeFn;
              }
              if (controllerDirectives) {
                elementControllers = setupControllers($element, attrs, transcludeFn, controllerDirectives, isolateScope, scope);
              }
              if (newIsolateScopeDirective) {
                compile.$$addScopeInfo($element, isolateScope, true, !(templateDirective && (templateDirective === newIsolateScopeDirective || templateDirective === newIsolateScopeDirective.$$originalDirective)));
                compile.$$addScopeClass($element, true);
                isolateScope.$$isolateBindings = newIsolateScopeDirective.$$isolateBindings;
                initializeDirectiveBindings(scope, attrs, isolateScope, isolateScope.$$isolateBindings, newIsolateScopeDirective, isolateScope);
              }
              if (elementControllers) {
                var scopeDirective = newIsolateScopeDirective || newScopeDirective;
                var bindings;
                var controllerForBindings;
                if (scopeDirective && elementControllers[scopeDirective.name]) {
                  bindings = scopeDirective.$$bindings.bindToController;
                  controller = elementControllers[scopeDirective.name];
                  if (controller && controller.identifier && bindings) {
                    controllerForBindings = controller;
                    thisLinkFn.$$destroyBindings = initializeDirectiveBindings(scope, attrs, controller.instance, bindings, scopeDirective);
                  }
                }
                for (i in elementControllers) {
                  controller = elementControllers[i];
                  var controllerResult = controller();
                  if (controllerResult !== controller.instance) {
                    controller.instance = controllerResult;
                    $element.data('$' + i + 'Controller', controllerResult);
                    if (controller === controllerForBindings) {
                      thisLinkFn.$$destroyBindings();
                      thisLinkFn.$$destroyBindings = initializeDirectiveBindings(scope, attrs, controllerResult, bindings, scopeDirective);
                    }
                  }
                }
              }
              for (i = 0, ii = preLinkFns.length; i < ii; i++) {
                linkFn = preLinkFns[i];
                invokeLinkFn(linkFn, linkFn.isolateScope ? isolateScope : scope, $element, attrs, linkFn.require && getControllers(linkFn.directiveName, linkFn.require, $element, elementControllers), transcludeFn);
              }
              var scopeToChild = scope;
              if (newIsolateScopeDirective && (newIsolateScopeDirective.template || newIsolateScopeDirective.templateUrl === null)) {
                scopeToChild = isolateScope;
              }
              childLinkFn && childLinkFn(scopeToChild, linkNode.childNodes, undefined, boundTranscludeFn);
              for (i = postLinkFns.length - 1; i >= 0; i--) {
                linkFn = postLinkFns[i];
                invokeLinkFn(linkFn, linkFn.isolateScope ? isolateScope : scope, $element, attrs, linkFn.require && getControllers(linkFn.directiveName, linkFn.require, $element, elementControllers), transcludeFn);
              }
              function controllersBoundTransclude(scope, cloneAttachFn, futureParentElement) {
                var transcludeControllers;
                if (!isScope(scope)) {
                  futureParentElement = cloneAttachFn;
                  cloneAttachFn = scope;
                  scope = undefined;
                }
                if (hasElementTranscludeDirective) {
                  transcludeControllers = elementControllers;
                }
                if (!futureParentElement) {
                  futureParentElement = hasElementTranscludeDirective ? $element.parent() : $element;
                }
                return boundTranscludeFn(scope, cloneAttachFn, transcludeControllers, futureParentElement, scopeToChild);
              }
            }
          }
          function markDirectivesAsIsolate(directives) {
            for (var j = 0,
                jj = directives.length; j < jj; j++) {
              directives[j] = inherit(directives[j], {$$isolateScope: true});
            }
          }
          function addDirective(tDirectives, name, location, maxPriority, ignoreDirective, startAttrName, endAttrName) {
            if (name === ignoreDirective)
              return null;
            var match = null;
            if (hasDirectives.hasOwnProperty(name)) {
              for (var directive,
                  directives = $injector.get(name + Suffix),
                  i = 0,
                  ii = directives.length; i < ii; i++) {
                try {
                  directive = directives[i];
                  if ((maxPriority === undefined || maxPriority > directive.priority) && directive.restrict.indexOf(location) != -1) {
                    if (startAttrName) {
                      directive = inherit(directive, {
                        $$start: startAttrName,
                        $$end: endAttrName
                      });
                    }
                    tDirectives.push(directive);
                    match = directive;
                  }
                } catch (e) {
                  $exceptionHandler(e);
                }
              }
            }
            return match;
          }
          function directiveIsMultiElement(name) {
            if (hasDirectives.hasOwnProperty(name)) {
              for (var directive,
                  directives = $injector.get(name + Suffix),
                  i = 0,
                  ii = directives.length; i < ii; i++) {
                directive = directives[i];
                if (directive.multiElement) {
                  return true;
                }
              }
            }
            return false;
          }
          function mergeTemplateAttributes(dst, src) {
            var srcAttr = src.$attr,
                dstAttr = dst.$attr,
                $element = dst.$$element;
            forEach(dst, function(value, key) {
              if (key.charAt(0) != '$') {
                if (src[key] && src[key] !== value) {
                  value += (key === 'style' ? ';' : ' ') + src[key];
                }
                dst.$set(key, value, true, srcAttr[key]);
              }
            });
            forEach(src, function(value, key) {
              if (key == 'class') {
                safeAddClass($element, value);
                dst['class'] = (dst['class'] ? dst['class'] + ' ' : '') + value;
              } else if (key == 'style') {
                $element.attr('style', $element.attr('style') + ';' + value);
                dst['style'] = (dst['style'] ? dst['style'] + ';' : '') + value;
              } else if (key.charAt(0) != '$' && !dst.hasOwnProperty(key)) {
                dst[key] = value;
                dstAttr[key] = srcAttr[key];
              }
            });
          }
          function compileTemplateUrl(directives, $compileNode, tAttrs, $rootElement, childTranscludeFn, preLinkFns, postLinkFns, previousCompileContext) {
            var linkQueue = [],
                afterTemplateNodeLinkFn,
                afterTemplateChildLinkFn,
                beforeTemplateCompileNode = $compileNode[0],
                origAsyncDirective = directives.shift(),
                derivedSyncDirective = inherit(origAsyncDirective, {
                  templateUrl: null,
                  transclude: null,
                  replace: null,
                  $$originalDirective: origAsyncDirective
                }),
                templateUrl = (isFunction(origAsyncDirective.templateUrl)) ? origAsyncDirective.templateUrl($compileNode, tAttrs) : origAsyncDirective.templateUrl,
                templateNamespace = origAsyncDirective.templateNamespace;
            $compileNode.empty();
            $templateRequest($sce.getTrustedResourceUrl(templateUrl)).then(function(content) {
              var compileNode,
                  tempTemplateAttrs,
                  $template,
                  childBoundTranscludeFn;
              content = denormalizeTemplate(content);
              if (origAsyncDirective.replace) {
                if (jqLiteIsTextNode(content)) {
                  $template = [];
                } else {
                  $template = removeComments(wrapTemplate(templateNamespace, trim(content)));
                }
                compileNode = $template[0];
                if ($template.length != 1 || compileNode.nodeType !== NODE_TYPE_ELEMENT) {
                  throw $compileMinErr('tplrt', "Template for directive '{0}' must have exactly one root element. {1}", origAsyncDirective.name, templateUrl);
                }
                tempTemplateAttrs = {$attr: {}};
                replaceWith($rootElement, $compileNode, compileNode);
                var templateDirectives = collectDirectives(compileNode, [], tempTemplateAttrs);
                if (isObject(origAsyncDirective.scope)) {
                  markDirectivesAsIsolate(templateDirectives);
                }
                directives = templateDirectives.concat(directives);
                mergeTemplateAttributes(tAttrs, tempTemplateAttrs);
              } else {
                compileNode = beforeTemplateCompileNode;
                $compileNode.html(content);
              }
              directives.unshift(derivedSyncDirective);
              afterTemplateNodeLinkFn = applyDirectivesToNode(directives, compileNode, tAttrs, childTranscludeFn, $compileNode, origAsyncDirective, preLinkFns, postLinkFns, previousCompileContext);
              forEach($rootElement, function(node, i) {
                if (node == compileNode) {
                  $rootElement[i] = $compileNode[0];
                }
              });
              afterTemplateChildLinkFn = compileNodes($compileNode[0].childNodes, childTranscludeFn);
              while (linkQueue.length) {
                var scope = linkQueue.shift(),
                    beforeTemplateLinkNode = linkQueue.shift(),
                    linkRootElement = linkQueue.shift(),
                    boundTranscludeFn = linkQueue.shift(),
                    linkNode = $compileNode[0];
                if (scope.$$destroyed)
                  continue;
                if (beforeTemplateLinkNode !== beforeTemplateCompileNode) {
                  var oldClasses = beforeTemplateLinkNode.className;
                  if (!(previousCompileContext.hasElementTranscludeDirective && origAsyncDirective.replace)) {
                    linkNode = jqLiteClone(compileNode);
                  }
                  replaceWith(linkRootElement, jqLite(beforeTemplateLinkNode), linkNode);
                  safeAddClass(jqLite(linkNode), oldClasses);
                }
                if (afterTemplateNodeLinkFn.transcludeOnThisElement) {
                  childBoundTranscludeFn = createBoundTranscludeFn(scope, afterTemplateNodeLinkFn.transclude, boundTranscludeFn);
                } else {
                  childBoundTranscludeFn = boundTranscludeFn;
                }
                afterTemplateNodeLinkFn(afterTemplateChildLinkFn, scope, linkNode, $rootElement, childBoundTranscludeFn, afterTemplateNodeLinkFn);
              }
              linkQueue = null;
            });
            return function delayedNodeLinkFn(ignoreChildLinkFn, scope, node, rootElement, boundTranscludeFn) {
              var childBoundTranscludeFn = boundTranscludeFn;
              if (scope.$$destroyed)
                return ;
              if (linkQueue) {
                linkQueue.push(scope, node, rootElement, childBoundTranscludeFn);
              } else {
                if (afterTemplateNodeLinkFn.transcludeOnThisElement) {
                  childBoundTranscludeFn = createBoundTranscludeFn(scope, afterTemplateNodeLinkFn.transclude, boundTranscludeFn);
                }
                afterTemplateNodeLinkFn(afterTemplateChildLinkFn, scope, node, rootElement, childBoundTranscludeFn, afterTemplateNodeLinkFn);
              }
            };
          }
          function byPriority(a, b) {
            var diff = b.priority - a.priority;
            if (diff !== 0)
              return diff;
            if (a.name !== b.name)
              return (a.name < b.name) ? -1 : 1;
            return a.index - b.index;
          }
          function assertNoDuplicate(what, previousDirective, directive, element) {
            function wrapModuleNameIfDefined(moduleName) {
              return moduleName ? (' (module: ' + moduleName + ')') : '';
            }
            if (previousDirective) {
              throw $compileMinErr('multidir', 'Multiple directives [{0}{1}, {2}{3}] asking for {4} on: {5}', previousDirective.name, wrapModuleNameIfDefined(previousDirective.$$moduleName), directive.name, wrapModuleNameIfDefined(directive.$$moduleName), what, startingTag(element));
            }
          }
          function addTextInterpolateDirective(directives, text) {
            var interpolateFn = $interpolate(text, true);
            if (interpolateFn) {
              directives.push({
                priority: 0,
                compile: function textInterpolateCompileFn(templateNode) {
                  var templateNodeParent = templateNode.parent(),
                      hasCompileParent = !!templateNodeParent.length;
                  if (hasCompileParent)
                    compile.$$addBindingClass(templateNodeParent);
                  return function textInterpolateLinkFn(scope, node) {
                    var parent = node.parent();
                    if (!hasCompileParent)
                      compile.$$addBindingClass(parent);
                    compile.$$addBindingInfo(parent, interpolateFn.expressions);
                    scope.$watch(interpolateFn, function interpolateFnWatchAction(value) {
                      node[0].nodeValue = value;
                    });
                  };
                }
              });
            }
          }
          function wrapTemplate(type, template) {
            type = lowercase(type || 'html');
            switch (type) {
              case 'svg':
              case 'math':
                var wrapper = document.createElement('div');
                wrapper.innerHTML = '<' + type + '>' + template + '</' + type + '>';
                return wrapper.childNodes[0].childNodes;
              default:
                return template;
            }
          }
          function getTrustedContext(node, attrNormalizedName) {
            if (attrNormalizedName == "srcdoc") {
              return $sce.HTML;
            }
            var tag = nodeName_(node);
            if (attrNormalizedName == "xlinkHref" || (tag == "form" && attrNormalizedName == "action") || (tag != "img" && (attrNormalizedName == "src" || attrNormalizedName == "ngSrc"))) {
              return $sce.RESOURCE_URL;
            }
          }
          function addAttrInterpolateDirective(node, directives, value, name, allOrNothing) {
            var trustedContext = getTrustedContext(node, name);
            allOrNothing = ALL_OR_NOTHING_ATTRS[name] || allOrNothing;
            var interpolateFn = $interpolate(value, true, trustedContext, allOrNothing);
            if (!interpolateFn)
              return ;
            if (name === "multiple" && nodeName_(node) === "select") {
              throw $compileMinErr("selmulti", "Binding to the 'multiple' attribute is not supported. Element: {0}", startingTag(node));
            }
            directives.push({
              priority: 100,
              compile: function() {
                return {pre: function attrInterpolatePreLinkFn(scope, element, attr) {
                    var $$observers = (attr.$$observers || (attr.$$observers = {}));
                    if (EVENT_HANDLER_ATTR_REGEXP.test(name)) {
                      throw $compileMinErr('nodomevents', "Interpolations for HTML DOM event attributes are disallowed.  Please use the " + "ng- versions (such as ng-click instead of onclick) instead.");
                    }
                    var newValue = attr[name];
                    if (newValue !== value) {
                      interpolateFn = newValue && $interpolate(newValue, true, trustedContext, allOrNothing);
                      value = newValue;
                    }
                    if (!interpolateFn)
                      return ;
                    attr[name] = interpolateFn(scope);
                    ($$observers[name] || ($$observers[name] = [])).$$inter = true;
                    (attr.$$observers && attr.$$observers[name].$$scope || scope).$watch(interpolateFn, function interpolateFnWatchAction(newValue, oldValue) {
                      if (name === 'class' && newValue != oldValue) {
                        attr.$updateClass(newValue, oldValue);
                      } else {
                        attr.$set(name, newValue);
                      }
                    });
                  }};
              }
            });
          }
          function replaceWith($rootElement, elementsToRemove, newNode) {
            var firstElementToRemove = elementsToRemove[0],
                removeCount = elementsToRemove.length,
                parent = firstElementToRemove.parentNode,
                i,
                ii;
            if ($rootElement) {
              for (i = 0, ii = $rootElement.length; i < ii; i++) {
                if ($rootElement[i] == firstElementToRemove) {
                  $rootElement[i++] = newNode;
                  for (var j = i,
                      j2 = j + removeCount - 1,
                      jj = $rootElement.length; j < jj; j++, j2++) {
                    if (j2 < jj) {
                      $rootElement[j] = $rootElement[j2];
                    } else {
                      delete $rootElement[j];
                    }
                  }
                  $rootElement.length -= removeCount - 1;
                  if ($rootElement.context === firstElementToRemove) {
                    $rootElement.context = newNode;
                  }
                  break;
                }
              }
            }
            if (parent) {
              parent.replaceChild(newNode, firstElementToRemove);
            }
            var fragment = document.createDocumentFragment();
            fragment.appendChild(firstElementToRemove);
            if (jqLite.hasData(firstElementToRemove)) {
              jqLite(newNode).data(jqLite(firstElementToRemove).data());
              if (!jQuery) {
                delete jqLite.cache[firstElementToRemove[jqLite.expando]];
              } else {
                skipDestroyOnNextJQueryCleanData = true;
                jQuery.cleanData([firstElementToRemove]);
              }
            }
            for (var k = 1,
                kk = elementsToRemove.length; k < kk; k++) {
              var element = elementsToRemove[k];
              jqLite(element).remove();
              fragment.appendChild(element);
              delete elementsToRemove[k];
            }
            elementsToRemove[0] = newNode;
            elementsToRemove.length = 1;
          }
          function cloneAndAnnotateFn(fn, annotation) {
            return extend(function() {
              return fn.apply(null, arguments);
            }, fn, annotation);
          }
          function invokeLinkFn(linkFn, scope, $element, attrs, controllers, transcludeFn) {
            try {
              linkFn(scope, $element, attrs, controllers, transcludeFn);
            } catch (e) {
              $exceptionHandler(e, startingTag($element));
            }
          }
          function initializeDirectiveBindings(scope, attrs, destination, bindings, directive, newScope) {
            var onNewScopeDestroyed;
            forEach(bindings, function(definition, scopeName) {
              var attrName = definition.attrName,
                  optional = definition.optional,
                  mode = definition.mode,
                  lastValue,
                  parentGet,
                  parentSet,
                  compare;
              if (!hasOwnProperty.call(attrs, attrName)) {
                attrs[attrName] = undefined;
              }
              switch (mode) {
                case '@':
                  if (!attrs[attrName] && !optional) {
                    destination[scopeName] = undefined;
                  }
                  attrs.$observe(attrName, function(value) {
                    destination[scopeName] = value;
                  });
                  attrs.$$observers[attrName].$$scope = scope;
                  if (attrs[attrName]) {
                    destination[scopeName] = $interpolate(attrs[attrName])(scope);
                  }
                  break;
                case '=':
                  if (optional && !attrs[attrName]) {
                    return ;
                  }
                  parentGet = $parse(attrs[attrName]);
                  if (parentGet.literal) {
                    compare = equals;
                  } else {
                    compare = function(a, b) {
                      return a === b || (a !== a && b !== b);
                    };
                  }
                  parentSet = parentGet.assign || function() {
                    lastValue = destination[scopeName] = parentGet(scope);
                    throw $compileMinErr('nonassign', "Expression '{0}' used with directive '{1}' is non-assignable!", attrs[attrName], directive.name);
                  };
                  lastValue = destination[scopeName] = parentGet(scope);
                  var parentValueWatch = function parentValueWatch(parentValue) {
                    if (!compare(parentValue, destination[scopeName])) {
                      if (!compare(parentValue, lastValue)) {
                        destination[scopeName] = parentValue;
                      } else {
                        parentSet(scope, parentValue = destination[scopeName]);
                      }
                    }
                    return lastValue = parentValue;
                  };
                  parentValueWatch.$stateful = true;
                  var unwatch;
                  if (definition.collection) {
                    unwatch = scope.$watchCollection(attrs[attrName], parentValueWatch);
                  } else {
                    unwatch = scope.$watch($parse(attrs[attrName], parentValueWatch), null, parentGet.literal);
                  }
                  onNewScopeDestroyed = (onNewScopeDestroyed || []);
                  onNewScopeDestroyed.push(unwatch);
                  break;
                case '&':
                  parentGet = $parse(attrs[attrName]);
                  if (parentGet === noop && optional)
                    break;
                  destination[scopeName] = function(locals) {
                    return parentGet(scope, locals);
                  };
                  break;
              }
            });
            var destroyBindings = onNewScopeDestroyed ? function destroyBindings() {
              for (var i = 0,
                  ii = onNewScopeDestroyed.length; i < ii; ++i) {
                onNewScopeDestroyed[i]();
              }
            } : noop;
            if (newScope && destroyBindings !== noop) {
              newScope.$on('$destroy', destroyBindings);
              return noop;
            }
            return destroyBindings;
          }
        }];
      }
      var PREFIX_REGEXP = /^((?:x|data)[\:\-_])/i;
      function directiveNormalize(name) {
        return camelCase(name.replace(PREFIX_REGEXP, ''));
      }
      function nodesetLinkingFn(scope, nodeList, rootElement, boundTranscludeFn) {}
      function directiveLinkingFn(nodesetLinkingFn, scope, node, rootElement, boundTranscludeFn) {}
      function tokenDifference(str1, str2) {
        var values = '',
            tokens1 = str1.split(/\s+/),
            tokens2 = str2.split(/\s+/);
        outer: for (var i = 0; i < tokens1.length; i++) {
          var token = tokens1[i];
          for (var j = 0; j < tokens2.length; j++) {
            if (token == tokens2[j])
              continue outer;
          }
          values += (values.length > 0 ? ' ' : '') + token;
        }
        return values;
      }
      function removeComments(jqNodes) {
        jqNodes = jqLite(jqNodes);
        var i = jqNodes.length;
        if (i <= 1) {
          return jqNodes;
        }
        while (i--) {
          var node = jqNodes[i];
          if (node.nodeType === NODE_TYPE_COMMENT) {
            splice.call(jqNodes, i, 1);
          }
        }
        return jqNodes;
      }
      var $controllerMinErr = minErr('$controller');
      var CNTRL_REG = /^(\S+)(\s+as\s+(\w+))?$/;
      function identifierForController(controller, ident) {
        if (ident && isString(ident))
          return ident;
        if (isString(controller)) {
          var match = CNTRL_REG.exec(controller);
          if (match)
            return match[3];
        }
      }
      function $ControllerProvider() {
        var controllers = {},
            globals = false;
        this.register = function(name, constructor) {
          assertNotHasOwnProperty(name, 'controller');
          if (isObject(name)) {
            extend(controllers, name);
          } else {
            controllers[name] = constructor;
          }
        };
        this.allowGlobals = function() {
          globals = true;
        };
        this.$get = ['$injector', '$window', function($injector, $window) {
          return function(expression, locals, later, ident) {
            var instance,
                match,
                constructor,
                identifier;
            later = later === true;
            if (ident && isString(ident)) {
              identifier = ident;
            }
            if (isString(expression)) {
              match = expression.match(CNTRL_REG);
              if (!match) {
                throw $controllerMinErr('ctrlfmt', "Badly formed controller string '{0}'. " + "Must match `__name__ as __id__` or `__name__`.", expression);
              }
              constructor = match[1], identifier = identifier || match[3];
              expression = controllers.hasOwnProperty(constructor) ? controllers[constructor] : getter(locals.$scope, constructor, true) || (globals ? getter($window, constructor, true) : undefined);
              assertArgFn(expression, constructor, true);
            }
            if (later) {
              var controllerPrototype = (isArray(expression) ? expression[expression.length - 1] : expression).prototype;
              instance = Object.create(controllerPrototype || null);
              if (identifier) {
                addIdentifier(locals, identifier, instance, constructor || expression.name);
              }
              var instantiate;
              return instantiate = extend(function() {
                var result = $injector.invoke(expression, instance, locals, constructor);
                if (result !== instance && (isObject(result) || isFunction(result))) {
                  instance = result;
                  if (identifier) {
                    addIdentifier(locals, identifier, instance, constructor || expression.name);
                  }
                }
                return instance;
              }, {
                instance: instance,
                identifier: identifier
              });
            }
            instance = $injector.instantiate(expression, locals, constructor);
            if (identifier) {
              addIdentifier(locals, identifier, instance, constructor || expression.name);
            }
            return instance;
          };
          function addIdentifier(locals, identifier, instance, name) {
            if (!(locals && isObject(locals.$scope))) {
              throw minErr('$controller')('noscp', "Cannot export controller '{0}' as '{1}'! No $scope object provided via `locals`.", name, identifier);
            }
            locals.$scope[identifier] = instance;
          }
        }];
      }
      function $DocumentProvider() {
        this.$get = ['$window', function(window) {
          return jqLite(window.document);
        }];
      }
      function $ExceptionHandlerProvider() {
        this.$get = ['$log', function($log) {
          return function(exception, cause) {
            $log.error.apply($log, arguments);
          };
        }];
      }
      var APPLICATION_JSON = 'application/json';
      var CONTENT_TYPE_APPLICATION_JSON = {'Content-Type': APPLICATION_JSON + ';charset=utf-8'};
      var JSON_START = /^\[|^\{(?!\{)/;
      var JSON_ENDS = {
        '[': /]$/,
        '{': /}$/
      };
      var JSON_PROTECTION_PREFIX = /^\)\]\}',?\n/;
      function serializeValue(v) {
        if (isObject(v)) {
          return isDate(v) ? v.toISOString() : toJson(v);
        }
        return v;
      }
      function $HttpParamSerializerProvider() {
        this.$get = function() {
          return function ngParamSerializer(params) {
            if (!params)
              return '';
            var parts = [];
            forEachSorted(params, function(value, key) {
              if (value === null || isUndefined(value))
                return ;
              if (isArray(value)) {
                forEach(value, function(v, k) {
                  parts.push(encodeUriQuery(key) + '=' + encodeUriQuery(serializeValue(v)));
                });
              } else {
                parts.push(encodeUriQuery(key) + '=' + encodeUriQuery(serializeValue(value)));
              }
            });
            return parts.join('&');
          };
        };
      }
      function $HttpParamSerializerJQLikeProvider() {
        this.$get = function() {
          return function jQueryLikeParamSerializer(params) {
            if (!params)
              return '';
            var parts = [];
            serialize(params, '', true);
            return parts.join('&');
            function serialize(toSerialize, prefix, topLevel) {
              if (toSerialize === null || isUndefined(toSerialize))
                return ;
              if (isArray(toSerialize)) {
                forEach(toSerialize, function(value) {
                  serialize(value, prefix + '[]');
                });
              } else if (isObject(toSerialize) && !isDate(toSerialize)) {
                forEachSorted(toSerialize, function(value, key) {
                  serialize(value, prefix + (topLevel ? '' : '[') + key + (topLevel ? '' : ']'));
                });
              } else {
                parts.push(encodeUriQuery(prefix) + '=' + encodeUriQuery(serializeValue(toSerialize)));
              }
            }
          };
        };
      }
      function defaultHttpResponseTransform(data, headers) {
        if (isString(data)) {
          var tempData = data.replace(JSON_PROTECTION_PREFIX, '').trim();
          if (tempData) {
            var contentType = headers('Content-Type');
            if ((contentType && (contentType.indexOf(APPLICATION_JSON) === 0)) || isJsonLike(tempData)) {
              data = fromJson(tempData);
            }
          }
        }
        return data;
      }
      function isJsonLike(str) {
        var jsonStart = str.match(JSON_START);
        return jsonStart && JSON_ENDS[jsonStart[0]].test(str);
      }
      function parseHeaders(headers) {
        var parsed = createMap(),
            i;
        function fillInParsed(key, val) {
          if (key) {
            parsed[key] = parsed[key] ? parsed[key] + ', ' + val : val;
          }
        }
        if (isString(headers)) {
          forEach(headers.split('\n'), function(line) {
            i = line.indexOf(':');
            fillInParsed(lowercase(trim(line.substr(0, i))), trim(line.substr(i + 1)));
          });
        } else if (isObject(headers)) {
          forEach(headers, function(headerVal, headerKey) {
            fillInParsed(lowercase(headerKey), trim(headerVal));
          });
        }
        return parsed;
      }
      function headersGetter(headers) {
        var headersObj;
        return function(name) {
          if (!headersObj)
            headersObj = parseHeaders(headers);
          if (name) {
            var value = headersObj[lowercase(name)];
            if (value === void 0) {
              value = null;
            }
            return value;
          }
          return headersObj;
        };
      }
      function transformData(data, headers, status, fns) {
        if (isFunction(fns)) {
          return fns(data, headers, status);
        }
        forEach(fns, function(fn) {
          data = fn(data, headers, status);
        });
        return data;
      }
      function isSuccess(status) {
        return 200 <= status && status < 300;
      }
      function $HttpProvider() {
        var defaults = this.defaults = {
          transformResponse: [defaultHttpResponseTransform],
          transformRequest: [function(d) {
            return isObject(d) && !isFile(d) && !isBlob(d) && !isFormData(d) ? toJson(d) : d;
          }],
          headers: {
            common: {'Accept': 'application/json, text/plain, */*'},
            post: shallowCopy(CONTENT_TYPE_APPLICATION_JSON),
            put: shallowCopy(CONTENT_TYPE_APPLICATION_JSON),
            patch: shallowCopy(CONTENT_TYPE_APPLICATION_JSON)
          },
          xsrfCookieName: 'XSRF-TOKEN',
          xsrfHeaderName: 'X-XSRF-TOKEN',
          paramSerializer: '$httpParamSerializer'
        };
        var useApplyAsync = false;
        this.useApplyAsync = function(value) {
          if (isDefined(value)) {
            useApplyAsync = !!value;
            return this;
          }
          return useApplyAsync;
        };
        var interceptorFactories = this.interceptors = [];
        this.$get = ['$httpBackend', '$$cookieReader', '$cacheFactory', '$rootScope', '$q', '$injector', function($httpBackend, $$cookieReader, $cacheFactory, $rootScope, $q, $injector) {
          var defaultCache = $cacheFactory('$http');
          defaults.paramSerializer = isString(defaults.paramSerializer) ? $injector.get(defaults.paramSerializer) : defaults.paramSerializer;
          var reversedInterceptors = [];
          forEach(interceptorFactories, function(interceptorFactory) {
            reversedInterceptors.unshift(isString(interceptorFactory) ? $injector.get(interceptorFactory) : $injector.invoke(interceptorFactory));
          });
          function $http(requestConfig) {
            if (!angular.isObject(requestConfig)) {
              throw minErr('$http')('badreq', 'Http request configuration must be an object.  Received: {0}', requestConfig);
            }
            var config = extend({
              method: 'get',
              transformRequest: defaults.transformRequest,
              transformResponse: defaults.transformResponse,
              paramSerializer: defaults.paramSerializer
            }, requestConfig);
            config.headers = mergeHeaders(requestConfig);
            config.method = uppercase(config.method);
            config.paramSerializer = isString(config.paramSerializer) ? $injector.get(config.paramSerializer) : config.paramSerializer;
            var serverRequest = function(config) {
              var headers = config.headers;
              var reqData = transformData(config.data, headersGetter(headers), undefined, config.transformRequest);
              if (isUndefined(reqData)) {
                forEach(headers, function(value, header) {
                  if (lowercase(header) === 'content-type') {
                    delete headers[header];
                  }
                });
              }
              if (isUndefined(config.withCredentials) && !isUndefined(defaults.withCredentials)) {
                config.withCredentials = defaults.withCredentials;
              }
              return sendReq(config, reqData).then(transformResponse, transformResponse);
            };
            var chain = [serverRequest, undefined];
            var promise = $q.when(config);
            forEach(reversedInterceptors, function(interceptor) {
              if (interceptor.request || interceptor.requestError) {
                chain.unshift(interceptor.request, interceptor.requestError);
              }
              if (interceptor.response || interceptor.responseError) {
                chain.push(interceptor.response, interceptor.responseError);
              }
            });
            while (chain.length) {
              var thenFn = chain.shift();
              var rejectFn = chain.shift();
              promise = promise.then(thenFn, rejectFn);
            }
            promise.success = function(fn) {
              assertArgFn(fn, 'fn');
              promise.then(function(response) {
                fn(response.data, response.status, response.headers, config);
              });
              return promise;
            };
            promise.error = function(fn) {
              assertArgFn(fn, 'fn');
              promise.then(null, function(response) {
                fn(response.data, response.status, response.headers, config);
              });
              return promise;
            };
            return promise;
            function transformResponse(response) {
              var resp = extend({}, response);
              if (!response.data) {
                resp.data = response.data;
              } else {
                resp.data = transformData(response.data, response.headers, response.status, config.transformResponse);
              }
              return (isSuccess(response.status)) ? resp : $q.reject(resp);
            }
            function executeHeaderFns(headers, config) {
              var headerContent,
                  processedHeaders = {};
              forEach(headers, function(headerFn, header) {
                if (isFunction(headerFn)) {
                  headerContent = headerFn(config);
                  if (headerContent != null) {
                    processedHeaders[header] = headerContent;
                  }
                } else {
                  processedHeaders[header] = headerFn;
                }
              });
              return processedHeaders;
            }
            function mergeHeaders(config) {
              var defHeaders = defaults.headers,
                  reqHeaders = extend({}, config.headers),
                  defHeaderName,
                  lowercaseDefHeaderName,
                  reqHeaderName;
              defHeaders = extend({}, defHeaders.common, defHeaders[lowercase(config.method)]);
              defaultHeadersIteration: for (defHeaderName in defHeaders) {
                lowercaseDefHeaderName = lowercase(defHeaderName);
                for (reqHeaderName in reqHeaders) {
                  if (lowercase(reqHeaderName) === lowercaseDefHeaderName) {
                    continue defaultHeadersIteration;
                  }
                }
                reqHeaders[defHeaderName] = defHeaders[defHeaderName];
              }
              return executeHeaderFns(reqHeaders, shallowCopy(config));
            }
          }
          $http.pendingRequests = [];
          createShortMethods('get', 'delete', 'head', 'jsonp');
          createShortMethodsWithData('post', 'put', 'patch');
          $http.defaults = defaults;
          return $http;
          function createShortMethods(names) {
            forEach(arguments, function(name) {
              $http[name] = function(url, config) {
                return $http(extend({}, config || {}, {
                  method: name,
                  url: url
                }));
              };
            });
          }
          function createShortMethodsWithData(name) {
            forEach(arguments, function(name) {
              $http[name] = function(url, data, config) {
                return $http(extend({}, config || {}, {
                  method: name,
                  url: url,
                  data: data
                }));
              };
            });
          }
          function sendReq(config, reqData) {
            var deferred = $q.defer(),
                promise = deferred.promise,
                cache,
                cachedResp,
                reqHeaders = config.headers,
                url = buildUrl(config.url, config.paramSerializer(config.params));
            $http.pendingRequests.push(config);
            promise.then(removePendingReq, removePendingReq);
            if ((config.cache || defaults.cache) && config.cache !== false && (config.method === 'GET' || config.method === 'JSONP')) {
              cache = isObject(config.cache) ? config.cache : isObject(defaults.cache) ? defaults.cache : defaultCache;
            }
            if (cache) {
              cachedResp = cache.get(url);
              if (isDefined(cachedResp)) {
                if (isPromiseLike(cachedResp)) {
                  cachedResp.then(resolvePromiseWithResult, resolvePromiseWithResult);
                } else {
                  if (isArray(cachedResp)) {
                    resolvePromise(cachedResp[1], cachedResp[0], shallowCopy(cachedResp[2]), cachedResp[3]);
                  } else {
                    resolvePromise(cachedResp, 200, {}, 'OK');
                  }
                }
              } else {
                cache.put(url, promise);
              }
            }
            if (isUndefined(cachedResp)) {
              var xsrfValue = urlIsSameOrigin(config.url) ? $$cookieReader()[config.xsrfCookieName || defaults.xsrfCookieName] : undefined;
              if (xsrfValue) {
                reqHeaders[(config.xsrfHeaderName || defaults.xsrfHeaderName)] = xsrfValue;
              }
              $httpBackend(config.method, url, reqData, done, reqHeaders, config.timeout, config.withCredentials, config.responseType);
            }
            return promise;
            function done(status, response, headersString, statusText) {
              if (cache) {
                if (isSuccess(status)) {
                  cache.put(url, [status, response, parseHeaders(headersString), statusText]);
                } else {
                  cache.remove(url);
                }
              }
              function resolveHttpPromise() {
                resolvePromise(response, status, headersString, statusText);
              }
              if (useApplyAsync) {
                $rootScope.$applyAsync(resolveHttpPromise);
              } else {
                resolveHttpPromise();
                if (!$rootScope.$$phase)
                  $rootScope.$apply();
              }
            }
            function resolvePromise(response, status, headers, statusText) {
              status = Math.max(status, 0);
              (isSuccess(status) ? deferred.resolve : deferred.reject)({
                data: response,
                status: status,
                headers: headersGetter(headers),
                config: config,
                statusText: statusText
              });
            }
            function resolvePromiseWithResult(result) {
              resolvePromise(result.data, result.status, shallowCopy(result.headers()), result.statusText);
            }
            function removePendingReq() {
              var idx = $http.pendingRequests.indexOf(config);
              if (idx !== -1)
                $http.pendingRequests.splice(idx, 1);
            }
          }
          function buildUrl(url, serializedParams) {
            if (serializedParams.length > 0) {
              url += ((url.indexOf('?') == -1) ? '?' : '&') + serializedParams;
            }
            return url;
          }
        }];
      }
      function createXhr() {
        return new window.XMLHttpRequest();
      }
      function $HttpBackendProvider() {
        this.$get = ['$browser', '$window', '$document', function($browser, $window, $document) {
          return createHttpBackend($browser, createXhr, $browser.defer, $window.angular.callbacks, $document[0]);
        }];
      }
      function createHttpBackend($browser, createXhr, $browserDefer, callbacks, rawDocument) {
        return function(method, url, post, callback, headers, timeout, withCredentials, responseType) {
          $browser.$$incOutstandingRequestCount();
          url = url || $browser.url();
          if (lowercase(method) == 'jsonp') {
            var callbackId = '_' + (callbacks.counter++).toString(36);
            callbacks[callbackId] = function(data) {
              callbacks[callbackId].data = data;
              callbacks[callbackId].called = true;
            };
            var jsonpDone = jsonpReq(url.replace('JSON_CALLBACK', 'angular.callbacks.' + callbackId), callbackId, function(status, text) {
              completeRequest(callback, status, callbacks[callbackId].data, "", text);
              callbacks[callbackId] = noop;
            });
          } else {
            var xhr = createXhr();
            xhr.open(method, url, true);
            forEach(headers, function(value, key) {
              if (isDefined(value)) {
                xhr.setRequestHeader(key, value);
              }
            });
            xhr.onload = function requestLoaded() {
              var statusText = xhr.statusText || '';
              var response = ('response' in xhr) ? xhr.response : xhr.responseText;
              var status = xhr.status === 1223 ? 204 : xhr.status;
              if (status === 0) {
                status = response ? 200 : urlResolve(url).protocol == 'file' ? 404 : 0;
              }
              completeRequest(callback, status, response, xhr.getAllResponseHeaders(), statusText);
            };
            var requestError = function() {
              completeRequest(callback, -1, null, null, '');
            };
            xhr.onerror = requestError;
            xhr.onabort = requestError;
            if (withCredentials) {
              xhr.withCredentials = true;
            }
            if (responseType) {
              try {
                xhr.responseType = responseType;
              } catch (e) {
                if (responseType !== 'json') {
                  throw e;
                }
              }
            }
            xhr.send(post);
          }
          if (timeout > 0) {
            var timeoutId = $browserDefer(timeoutRequest, timeout);
          } else if (isPromiseLike(timeout)) {
            timeout.then(timeoutRequest);
          }
          function timeoutRequest() {
            jsonpDone && jsonpDone();
            xhr && xhr.abort();
          }
          function completeRequest(callback, status, response, headersString, statusText) {
            if (timeoutId !== undefined) {
              $browserDefer.cancel(timeoutId);
            }
            jsonpDone = xhr = null;
            callback(status, response, headersString, statusText);
            $browser.$$completeOutstandingRequest(noop);
          }
        };
        function jsonpReq(url, callbackId, done) {
          var script = rawDocument.createElement('script'),
              callback = null;
          script.type = "text/javascript";
          script.src = url;
          script.async = true;
          callback = function(event) {
            removeEventListenerFn(script, "load", callback);
            removeEventListenerFn(script, "error", callback);
            rawDocument.body.removeChild(script);
            script = null;
            var status = -1;
            var text = "unknown";
            if (event) {
              if (event.type === "load" && !callbacks[callbackId].called) {
                event = {type: "error"};
              }
              text = event.type;
              status = event.type === "error" ? 404 : 200;
            }
            if (done) {
              done(status, text);
            }
          };
          addEventListenerFn(script, "load", callback);
          addEventListenerFn(script, "error", callback);
          rawDocument.body.appendChild(script);
          return callback;
        }
      }
      var $interpolateMinErr = angular.$interpolateMinErr = minErr('$interpolate');
      $interpolateMinErr.throwNoconcat = function(text) {
        throw $interpolateMinErr('noconcat', "Error while interpolating: {0}\nStrict Contextual Escaping disallows " + "interpolations that concatenate multiple expressions when a trusted value is " + "required.  See http://docs.angularjs.org/api/ng.$sce", text);
      };
      $interpolateMinErr.interr = function(text, err) {
        return $interpolateMinErr('interr', "Can't interpolate: {0}\n{1}", text, err.toString());
      };
      function $InterpolateProvider() {
        var startSymbol = '{{';
        var endSymbol = '}}';
        this.startSymbol = function(value) {
          if (value) {
            startSymbol = value;
            return this;
          } else {
            return startSymbol;
          }
        };
        this.endSymbol = function(value) {
          if (value) {
            endSymbol = value;
            return this;
          } else {
            return endSymbol;
          }
        };
        this.$get = ['$parse', '$exceptionHandler', '$sce', function($parse, $exceptionHandler, $sce) {
          var startSymbolLength = startSymbol.length,
              endSymbolLength = endSymbol.length,
              escapedStartRegexp = new RegExp(startSymbol.replace(/./g, escape), 'g'),
              escapedEndRegexp = new RegExp(endSymbol.replace(/./g, escape), 'g');
          function escape(ch) {
            return '\\\\\\' + ch;
          }
          function unescapeText(text) {
            return text.replace(escapedStartRegexp, startSymbol).replace(escapedEndRegexp, endSymbol);
          }
          function stringify(value) {
            if (value == null) {
              return '';
            }
            switch (typeof value) {
              case 'string':
                break;
              case 'number':
                value = '' + value;
                break;
              default:
                value = toJson(value);
            }
            return value;
          }
          function $interpolate(text, mustHaveExpression, trustedContext, allOrNothing) {
            allOrNothing = !!allOrNothing;
            var startIndex,
                endIndex,
                index = 0,
                expressions = [],
                parseFns = [],
                textLength = text.length,
                exp,
                concat = [],
                expressionPositions = [];
            while (index < textLength) {
              if (((startIndex = text.indexOf(startSymbol, index)) != -1) && ((endIndex = text.indexOf(endSymbol, startIndex + startSymbolLength)) != -1)) {
                if (index !== startIndex) {
                  concat.push(unescapeText(text.substring(index, startIndex)));
                }
                exp = text.substring(startIndex + startSymbolLength, endIndex);
                expressions.push(exp);
                parseFns.push($parse(exp, parseStringifyInterceptor));
                index = endIndex + endSymbolLength;
                expressionPositions.push(concat.length);
                concat.push('');
              } else {
                if (index !== textLength) {
                  concat.push(unescapeText(text.substring(index)));
                }
                break;
              }
            }
            if (trustedContext && concat.length > 1) {
              $interpolateMinErr.throwNoconcat(text);
            }
            if (!mustHaveExpression || expressions.length) {
              var compute = function(values) {
                for (var i = 0,
                    ii = expressions.length; i < ii; i++) {
                  if (allOrNothing && isUndefined(values[i]))
                    return ;
                  concat[expressionPositions[i]] = values[i];
                }
                return concat.join('');
              };
              var getValue = function(value) {
                return trustedContext ? $sce.getTrusted(trustedContext, value) : $sce.valueOf(value);
              };
              return extend(function interpolationFn(context) {
                var i = 0;
                var ii = expressions.length;
                var values = new Array(ii);
                try {
                  for (; i < ii; i++) {
                    values[i] = parseFns[i](context);
                  }
                  return compute(values);
                } catch (err) {
                  $exceptionHandler($interpolateMinErr.interr(text, err));
                }
              }, {
                exp: text,
                expressions: expressions,
                $$watchDelegate: function(scope, listener) {
                  var lastValue;
                  return scope.$watchGroup(parseFns, function interpolateFnWatcher(values, oldValues) {
                    var currValue = compute(values);
                    if (isFunction(listener)) {
                      listener.call(this, currValue, values !== oldValues ? lastValue : currValue, scope);
                    }
                    lastValue = currValue;
                  });
                }
              });
            }
            function parseStringifyInterceptor(value) {
              try {
                value = getValue(value);
                return allOrNothing && !isDefined(value) ? value : stringify(value);
              } catch (err) {
                $exceptionHandler($interpolateMinErr.interr(text, err));
              }
            }
          }
          $interpolate.startSymbol = function() {
            return startSymbol;
          };
          $interpolate.endSymbol = function() {
            return endSymbol;
          };
          return $interpolate;
        }];
      }
      function $IntervalProvider() {
        this.$get = ['$rootScope', '$window', '$q', '$$q', function($rootScope, $window, $q, $$q) {
          var intervals = {};
          function interval(fn, delay, count, invokeApply) {
            var hasParams = arguments.length > 4,
                args = hasParams ? sliceArgs(arguments, 4) : [],
                setInterval = $window.setInterval,
                clearInterval = $window.clearInterval,
                iteration = 0,
                skipApply = (isDefined(invokeApply) && !invokeApply),
                deferred = (skipApply ? $$q : $q).defer(),
                promise = deferred.promise;
            count = isDefined(count) ? count : 0;
            promise.then(null, null, (!hasParams) ? fn : function() {
              fn.apply(null, args);
            });
            promise.$$intervalId = setInterval(function tick() {
              deferred.notify(iteration++);
              if (count > 0 && iteration >= count) {
                deferred.resolve(iteration);
                clearInterval(promise.$$intervalId);
                delete intervals[promise.$$intervalId];
              }
              if (!skipApply)
                $rootScope.$apply();
            }, delay);
            intervals[promise.$$intervalId] = deferred;
            return promise;
          }
          interval.cancel = function(promise) {
            if (promise && promise.$$intervalId in intervals) {
              intervals[promise.$$intervalId].reject('canceled');
              $window.clearInterval(promise.$$intervalId);
              delete intervals[promise.$$intervalId];
              return true;
            }
            return false;
          };
          return interval;
        }];
      }
      function $LocaleProvider() {
        this.$get = function() {
          return {
            id: 'en-us',
            NUMBER_FORMATS: {
              DECIMAL_SEP: '.',
              GROUP_SEP: ',',
              PATTERNS: [{
                minInt: 1,
                minFrac: 0,
                maxFrac: 3,
                posPre: '',
                posSuf: '',
                negPre: '-',
                negSuf: '',
                gSize: 3,
                lgSize: 3
              }, {
                minInt: 1,
                minFrac: 2,
                maxFrac: 2,
                posPre: '\u00A4',
                posSuf: '',
                negPre: '(\u00A4',
                negSuf: ')',
                gSize: 3,
                lgSize: 3
              }],
              CURRENCY_SYM: '$'
            },
            DATETIME_FORMATS: {
              MONTH: 'January,February,March,April,May,June,July,August,September,October,November,December'.split(','),
              SHORTMONTH: 'Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec'.split(','),
              DAY: 'Sunday,Monday,Tuesday,Wednesday,Thursday,Friday,Saturday'.split(','),
              SHORTDAY: 'Sun,Mon,Tue,Wed,Thu,Fri,Sat'.split(','),
              AMPMS: ['AM', 'PM'],
              medium: 'MMM d, y h:mm:ss a',
              'short': 'M/d/yy h:mm a',
              fullDate: 'EEEE, MMMM d, y',
              longDate: 'MMMM d, y',
              mediumDate: 'MMM d, y',
              shortDate: 'M/d/yy',
              mediumTime: 'h:mm:ss a',
              shortTime: 'h:mm a',
              ERANAMES: ["Before Christ", "Anno Domini"],
              ERAS: ["BC", "AD"]
            },
            pluralCat: function(num) {
              if (num === 1) {
                return 'one';
              }
              return 'other';
            }
          };
        };
      }
      var PATH_MATCH = /^([^\?#]*)(\?([^#]*))?(#(.*))?$/,
          DEFAULT_PORTS = {
            'http': 80,
            'https': 443,
            'ftp': 21
          };
      var $locationMinErr = minErr('$location');
      function encodePath(path) {
        var segments = path.split('/'),
            i = segments.length;
        while (i--) {
          segments[i] = encodeUriSegment(segments[i]);
        }
        return segments.join('/');
      }
      function parseAbsoluteUrl(absoluteUrl, locationObj) {
        var parsedUrl = urlResolve(absoluteUrl);
        locationObj.$$protocol = parsedUrl.protocol;
        locationObj.$$host = parsedUrl.hostname;
        locationObj.$$port = toInt(parsedUrl.port) || DEFAULT_PORTS[parsedUrl.protocol] || null;
      }
      function parseAppUrl(relativeUrl, locationObj) {
        var prefixed = (relativeUrl.charAt(0) !== '/');
        if (prefixed) {
          relativeUrl = '/' + relativeUrl;
        }
        var match = urlResolve(relativeUrl);
        locationObj.$$path = decodeURIComponent(prefixed && match.pathname.charAt(0) === '/' ? match.pathname.substring(1) : match.pathname);
        locationObj.$$search = parseKeyValue(match.search);
        locationObj.$$hash = decodeURIComponent(match.hash);
        if (locationObj.$$path && locationObj.$$path.charAt(0) != '/') {
          locationObj.$$path = '/' + locationObj.$$path;
        }
      }
      function beginsWith(begin, whole) {
        if (whole.indexOf(begin) === 0) {
          return whole.substr(begin.length);
        }
      }
      function stripHash(url) {
        var index = url.indexOf('#');
        return index == -1 ? url : url.substr(0, index);
      }
      function trimEmptyHash(url) {
        return url.replace(/(#.+)|#$/, '$1');
      }
      function stripFile(url) {
        return url.substr(0, stripHash(url).lastIndexOf('/') + 1);
      }
      function serverBase(url) {
        return url.substring(0, url.indexOf('/', url.indexOf('//') + 2));
      }
      function LocationHtml5Url(appBase, basePrefix) {
        this.$$html5 = true;
        basePrefix = basePrefix || '';
        var appBaseNoFile = stripFile(appBase);
        parseAbsoluteUrl(appBase, this);
        this.$$parse = function(url) {
          var pathUrl = beginsWith(appBaseNoFile, url);
          if (!isString(pathUrl)) {
            throw $locationMinErr('ipthprfx', 'Invalid url "{0}", missing path prefix "{1}".', url, appBaseNoFile);
          }
          parseAppUrl(pathUrl, this);
          if (!this.$$path) {
            this.$$path = '/';
          }
          this.$$compose();
        };
        this.$$compose = function() {
          var search = toKeyValue(this.$$search),
              hash = this.$$hash ? '#' + encodeUriSegment(this.$$hash) : '';
          this.$$url = encodePath(this.$$path) + (search ? '?' + search : '') + hash;
          this.$$absUrl = appBaseNoFile + this.$$url.substr(1);
        };
        this.$$parseLinkUrl = function(url, relHref) {
          if (relHref && relHref[0] === '#') {
            this.hash(relHref.slice(1));
            return true;
          }
          var appUrl,
              prevAppUrl;
          var rewrittenUrl;
          if ((appUrl = beginsWith(appBase, url)) !== undefined) {
            prevAppUrl = appUrl;
            if ((appUrl = beginsWith(basePrefix, appUrl)) !== undefined) {
              rewrittenUrl = appBaseNoFile + (beginsWith('/', appUrl) || appUrl);
            } else {
              rewrittenUrl = appBase + prevAppUrl;
            }
          } else if ((appUrl = beginsWith(appBaseNoFile, url)) !== undefined) {
            rewrittenUrl = appBaseNoFile + appUrl;
          } else if (appBaseNoFile == url + '/') {
            rewrittenUrl = appBaseNoFile;
          }
          if (rewrittenUrl) {
            this.$$parse(rewrittenUrl);
          }
          return !!rewrittenUrl;
        };
      }
      function LocationHashbangUrl(appBase, hashPrefix) {
        var appBaseNoFile = stripFile(appBase);
        parseAbsoluteUrl(appBase, this);
        this.$$parse = function(url) {
          var withoutBaseUrl = beginsWith(appBase, url) || beginsWith(appBaseNoFile, url);
          var withoutHashUrl;
          if (withoutBaseUrl.charAt(0) === '#') {
            withoutHashUrl = beginsWith(hashPrefix, withoutBaseUrl);
            if (isUndefined(withoutHashUrl)) {
              withoutHashUrl = withoutBaseUrl;
            }
          } else {
            withoutHashUrl = this.$$html5 ? withoutBaseUrl : '';
          }
          parseAppUrl(withoutHashUrl, this);
          this.$$path = removeWindowsDriveName(this.$$path, withoutHashUrl, appBase);
          this.$$compose();
          function removeWindowsDriveName(path, url, base) {
            var windowsFilePathExp = /^\/[A-Z]:(\/.*)/;
            var firstPathSegmentMatch;
            if (url.indexOf(base) === 0) {
              url = url.replace(base, '');
            }
            if (windowsFilePathExp.exec(url)) {
              return path;
            }
            firstPathSegmentMatch = windowsFilePathExp.exec(path);
            return firstPathSegmentMatch ? firstPathSegmentMatch[1] : path;
          }
        };
        this.$$compose = function() {
          var search = toKeyValue(this.$$search),
              hash = this.$$hash ? '#' + encodeUriSegment(this.$$hash) : '';
          this.$$url = encodePath(this.$$path) + (search ? '?' + search : '') + hash;
          this.$$absUrl = appBase + (this.$$url ? hashPrefix + this.$$url : '');
        };
        this.$$parseLinkUrl = function(url, relHref) {
          if (stripHash(appBase) == stripHash(url)) {
            this.$$parse(url);
            return true;
          }
          return false;
        };
      }
      function LocationHashbangInHtml5Url(appBase, hashPrefix) {
        this.$$html5 = true;
        LocationHashbangUrl.apply(this, arguments);
        var appBaseNoFile = stripFile(appBase);
        this.$$parseLinkUrl = function(url, relHref) {
          if (relHref && relHref[0] === '#') {
            this.hash(relHref.slice(1));
            return true;
          }
          var rewrittenUrl;
          var appUrl;
          if (appBase == stripHash(url)) {
            rewrittenUrl = url;
          } else if ((appUrl = beginsWith(appBaseNoFile, url))) {
            rewrittenUrl = appBase + hashPrefix + appUrl;
          } else if (appBaseNoFile === url + '/') {
            rewrittenUrl = appBaseNoFile;
          }
          if (rewrittenUrl) {
            this.$$parse(rewrittenUrl);
          }
          return !!rewrittenUrl;
        };
        this.$$compose = function() {
          var search = toKeyValue(this.$$search),
              hash = this.$$hash ? '#' + encodeUriSegment(this.$$hash) : '';
          this.$$url = encodePath(this.$$path) + (search ? '?' + search : '') + hash;
          this.$$absUrl = appBase + hashPrefix + this.$$url;
        };
      }
      var locationPrototype = {
        $$html5: false,
        $$replace: false,
        absUrl: locationGetter('$$absUrl'),
        url: function(url) {
          if (isUndefined(url)) {
            return this.$$url;
          }
          var match = PATH_MATCH.exec(url);
          if (match[1] || url === '')
            this.path(decodeURIComponent(match[1]));
          if (match[2] || match[1] || url === '')
            this.search(match[3] || '');
          this.hash(match[5] || '');
          return this;
        },
        protocol: locationGetter('$$protocol'),
        host: locationGetter('$$host'),
        port: locationGetter('$$port'),
        path: locationGetterSetter('$$path', function(path) {
          path = path !== null ? path.toString() : '';
          return path.charAt(0) == '/' ? path : '/' + path;
        }),
        search: function(search, paramValue) {
          switch (arguments.length) {
            case 0:
              return this.$$search;
            case 1:
              if (isString(search) || isNumber(search)) {
                search = search.toString();
                this.$$search = parseKeyValue(search);
              } else if (isObject(search)) {
                search = copy(search, {});
                forEach(search, function(value, key) {
                  if (value == null)
                    delete search[key];
                });
                this.$$search = search;
              } else {
                throw $locationMinErr('isrcharg', 'The first argument of the `$location#search()` call must be a string or an object.');
              }
              break;
            default:
              if (isUndefined(paramValue) || paramValue === null) {
                delete this.$$search[search];
              } else {
                this.$$search[search] = paramValue;
              }
          }
          this.$$compose();
          return this;
        },
        hash: locationGetterSetter('$$hash', function(hash) {
          return hash !== null ? hash.toString() : '';
        }),
        replace: function() {
          this.$$replace = true;
          return this;
        }
      };
      forEach([LocationHashbangInHtml5Url, LocationHashbangUrl, LocationHtml5Url], function(Location) {
        Location.prototype = Object.create(locationPrototype);
        Location.prototype.state = function(state) {
          if (!arguments.length) {
            return this.$$state;
          }
          if (Location !== LocationHtml5Url || !this.$$html5) {
            throw $locationMinErr('nostate', 'History API state support is available only ' + 'in HTML5 mode and only in browsers supporting HTML5 History API');
          }
          this.$$state = isUndefined(state) ? null : state;
          return this;
        };
      });
      function locationGetter(property) {
        return function() {
          return this[property];
        };
      }
      function locationGetterSetter(property, preprocess) {
        return function(value) {
          if (isUndefined(value)) {
            return this[property];
          }
          this[property] = preprocess(value);
          this.$$compose();
          return this;
        };
      }
      function $LocationProvider() {
        var hashPrefix = '',
            html5Mode = {
              enabled: false,
              requireBase: true,
              rewriteLinks: true
            };
        this.hashPrefix = function(prefix) {
          if (isDefined(prefix)) {
            hashPrefix = prefix;
            return this;
          } else {
            return hashPrefix;
          }
        };
        this.html5Mode = function(mode) {
          if (isBoolean(mode)) {
            html5Mode.enabled = mode;
            return this;
          } else if (isObject(mode)) {
            if (isBoolean(mode.enabled)) {
              html5Mode.enabled = mode.enabled;
            }
            if (isBoolean(mode.requireBase)) {
              html5Mode.requireBase = mode.requireBase;
            }
            if (isBoolean(mode.rewriteLinks)) {
              html5Mode.rewriteLinks = mode.rewriteLinks;
            }
            return this;
          } else {
            return html5Mode;
          }
        };
        this.$get = ['$rootScope', '$browser', '$sniffer', '$rootElement', '$window', function($rootScope, $browser, $sniffer, $rootElement, $window) {
          var $location,
              LocationMode,
              baseHref = $browser.baseHref(),
              initialUrl = $browser.url(),
              appBase;
          if (html5Mode.enabled) {
            if (!baseHref && html5Mode.requireBase) {
              throw $locationMinErr('nobase', "$location in HTML5 mode requires a <base> tag to be present!");
            }
            appBase = serverBase(initialUrl) + (baseHref || '/');
            LocationMode = $sniffer.history ? LocationHtml5Url : LocationHashbangInHtml5Url;
          } else {
            appBase = stripHash(initialUrl);
            LocationMode = LocationHashbangUrl;
          }
          $location = new LocationMode(appBase, '#' + hashPrefix);
          $location.$$parseLinkUrl(initialUrl, initialUrl);
          $location.$$state = $browser.state();
          var IGNORE_URI_REGEXP = /^\s*(javascript|mailto):/i;
          function setBrowserUrlWithFallback(url, replace, state) {
            var oldUrl = $location.url();
            var oldState = $location.$$state;
            try {
              $browser.url(url, replace, state);
              $location.$$state = $browser.state();
            } catch (e) {
              $location.url(oldUrl);
              $location.$$state = oldState;
              throw e;
            }
          }
          $rootElement.on('click', function(event) {
            if (!html5Mode.rewriteLinks || event.ctrlKey || event.metaKey || event.shiftKey || event.which == 2 || event.button == 2)
              return ;
            var elm = jqLite(event.target);
            while (nodeName_(elm[0]) !== 'a') {
              if (elm[0] === $rootElement[0] || !(elm = elm.parent())[0])
                return ;
            }
            var absHref = elm.prop('href');
            var relHref = elm.attr('href') || elm.attr('xlink:href');
            if (isObject(absHref) && absHref.toString() === '[object SVGAnimatedString]') {
              absHref = urlResolve(absHref.animVal).href;
            }
            if (IGNORE_URI_REGEXP.test(absHref))
              return ;
            if (absHref && !elm.attr('target') && !event.isDefaultPrevented()) {
              if ($location.$$parseLinkUrl(absHref, relHref)) {
                event.preventDefault();
                if ($location.absUrl() != $browser.url()) {
                  $rootScope.$apply();
                  $window.angular['ff-684208-preventDefault'] = true;
                }
              }
            }
          });
          if (trimEmptyHash($location.absUrl()) != trimEmptyHash(initialUrl)) {
            $browser.url($location.absUrl(), true);
          }
          var initializing = true;
          $browser.onUrlChange(function(newUrl, newState) {
            $rootScope.$evalAsync(function() {
              var oldUrl = $location.absUrl();
              var oldState = $location.$$state;
              var defaultPrevented;
              $location.$$parse(newUrl);
              $location.$$state = newState;
              defaultPrevented = $rootScope.$broadcast('$locationChangeStart', newUrl, oldUrl, newState, oldState).defaultPrevented;
              if ($location.absUrl() !== newUrl)
                return ;
              if (defaultPrevented) {
                $location.$$parse(oldUrl);
                $location.$$state = oldState;
                setBrowserUrlWithFallback(oldUrl, false, oldState);
              } else {
                initializing = false;
                afterLocationChange(oldUrl, oldState);
              }
            });
            if (!$rootScope.$$phase)
              $rootScope.$digest();
          });
          $rootScope.$watch(function $locationWatch() {
            var oldUrl = trimEmptyHash($browser.url());
            var newUrl = trimEmptyHash($location.absUrl());
            var oldState = $browser.state();
            var currentReplace = $location.$$replace;
            var urlOrStateChanged = oldUrl !== newUrl || ($location.$$html5 && $sniffer.history && oldState !== $location.$$state);
            if (initializing || urlOrStateChanged) {
              initializing = false;
              $rootScope.$evalAsync(function() {
                var newUrl = $location.absUrl();
                var defaultPrevented = $rootScope.$broadcast('$locationChangeStart', newUrl, oldUrl, $location.$$state, oldState).defaultPrevented;
                if ($location.absUrl() !== newUrl)
                  return ;
                if (defaultPrevented) {
                  $location.$$parse(oldUrl);
                  $location.$$state = oldState;
                } else {
                  if (urlOrStateChanged) {
                    setBrowserUrlWithFallback(newUrl, currentReplace, oldState === $location.$$state ? null : $location.$$state);
                  }
                  afterLocationChange(oldUrl, oldState);
                }
              });
            }
            $location.$$replace = false;
          });
          return $location;
          function afterLocationChange(oldUrl, oldState) {
            $rootScope.$broadcast('$locationChangeSuccess', $location.absUrl(), oldUrl, $location.$$state, oldState);
          }
        }];
      }
      function $LogProvider() {
        var debug = true,
            self = this;
        this.debugEnabled = function(flag) {
          if (isDefined(flag)) {
            debug = flag;
            return this;
          } else {
            return debug;
          }
        };
        this.$get = ['$window', function($window) {
          return {
            log: consoleLog('log'),
            info: consoleLog('info'),
            warn: consoleLog('warn'),
            error: consoleLog('error'),
            debug: (function() {
              var fn = consoleLog('debug');
              return function() {
                if (debug) {
                  fn.apply(self, arguments);
                }
              };
            }())
          };
          function formatError(arg) {
            if (arg instanceof Error) {
              if (arg.stack) {
                arg = (arg.message && arg.stack.indexOf(arg.message) === -1) ? 'Error: ' + arg.message + '\n' + arg.stack : arg.stack;
              } else if (arg.sourceURL) {
                arg = arg.message + '\n' + arg.sourceURL + ':' + arg.line;
              }
            }
            return arg;
          }
          function consoleLog(type) {
            var console = $window.console || {},
                logFn = console[type] || console.log || noop,
                hasApply = false;
            try {
              hasApply = !!logFn.apply;
            } catch (e) {}
            if (hasApply) {
              return function() {
                var args = [];
                forEach(arguments, function(arg) {
                  args.push(formatError(arg));
                });
                return logFn.apply(console, args);
              };
            }
            return function(arg1, arg2) {
              logFn(arg1, arg2 == null ? '' : arg2);
            };
          }
        }];
      }
      var $parseMinErr = minErr('$parse');
      function ensureSafeMemberName(name, fullExpression) {
        if (name === "__defineGetter__" || name === "__defineSetter__" || name === "__lookupGetter__" || name === "__lookupSetter__" || name === "__proto__") {
          throw $parseMinErr('isecfld', 'Attempting to access a disallowed field in Angular expressions! ' + 'Expression: {0}', fullExpression);
        }
        return name;
      }
      function ensureSafeObject(obj, fullExpression) {
        if (obj) {
          if (obj.constructor === obj) {
            throw $parseMinErr('isecfn', 'Referencing Function in Angular expressions is disallowed! Expression: {0}', fullExpression);
          } else if (obj.window === obj) {
            throw $parseMinErr('isecwindow', 'Referencing the Window in Angular expressions is disallowed! Expression: {0}', fullExpression);
          } else if (obj.children && (obj.nodeName || (obj.prop && obj.attr && obj.find))) {
            throw $parseMinErr('isecdom', 'Referencing DOM nodes in Angular expressions is disallowed! Expression: {0}', fullExpression);
          } else if (obj === Object) {
            throw $parseMinErr('isecobj', 'Referencing Object in Angular expressions is disallowed! Expression: {0}', fullExpression);
          }
        }
        return obj;
      }
      var CALL = Function.prototype.call;
      var APPLY = Function.prototype.apply;
      var BIND = Function.prototype.bind;
      function ensureSafeFunction(obj, fullExpression) {
        if (obj) {
          if (obj.constructor === obj) {
            throw $parseMinErr('isecfn', 'Referencing Function in Angular expressions is disallowed! Expression: {0}', fullExpression);
          } else if (obj === CALL || obj === APPLY || obj === BIND) {
            throw $parseMinErr('isecff', 'Referencing call, apply or bind in Angular expressions is disallowed! Expression: {0}', fullExpression);
          }
        }
      }
      var OPERATORS = createMap();
      forEach('+ - * / % === !== == != < > <= >= && || ! = |'.split(' '), function(operator) {
        OPERATORS[operator] = true;
      });
      var ESCAPE = {
        "n": "\n",
        "f": "\f",
        "r": "\r",
        "t": "\t",
        "v": "\v",
        "'": "'",
        '"': '"'
      };
      var Lexer = function(options) {
        this.options = options;
      };
      Lexer.prototype = {
        constructor: Lexer,
        lex: function(text) {
          this.text = text;
          this.index = 0;
          this.tokens = [];
          while (this.index < this.text.length) {
            var ch = this.text.charAt(this.index);
            if (ch === '"' || ch === "'") {
              this.readString(ch);
            } else if (this.isNumber(ch) || ch === '.' && this.isNumber(this.peek())) {
              this.readNumber();
            } else if (this.isIdent(ch)) {
              this.readIdent();
            } else if (this.is(ch, '(){}[].,;:?')) {
              this.tokens.push({
                index: this.index,
                text: ch
              });
              this.index++;
            } else if (this.isWhitespace(ch)) {
              this.index++;
            } else {
              var ch2 = ch + this.peek();
              var ch3 = ch2 + this.peek(2);
              var op1 = OPERATORS[ch];
              var op2 = OPERATORS[ch2];
              var op3 = OPERATORS[ch3];
              if (op1 || op2 || op3) {
                var token = op3 ? ch3 : (op2 ? ch2 : ch);
                this.tokens.push({
                  index: this.index,
                  text: token,
                  operator: true
                });
                this.index += token.length;
              } else {
                this.throwError('Unexpected next character ', this.index, this.index + 1);
              }
            }
          }
          return this.tokens;
        },
        is: function(ch, chars) {
          return chars.indexOf(ch) !== -1;
        },
        peek: function(i) {
          var num = i || 1;
          return (this.index + num < this.text.length) ? this.text.charAt(this.index + num) : false;
        },
        isNumber: function(ch) {
          return ('0' <= ch && ch <= '9') && typeof ch === "string";
        },
        isWhitespace: function(ch) {
          return (ch === ' ' || ch === '\r' || ch === '\t' || ch === '\n' || ch === '\v' || ch === '\u00A0');
        },
        isIdent: function(ch) {
          return ('a' <= ch && ch <= 'z' || 'A' <= ch && ch <= 'Z' || '_' === ch || ch === '$');
        },
        isExpOperator: function(ch) {
          return (ch === '-' || ch === '+' || this.isNumber(ch));
        },
        throwError: function(error, start, end) {
          end = end || this.index;
          var colStr = (isDefined(start) ? 's ' + start + '-' + this.index + ' [' + this.text.substring(start, end) + ']' : ' ' + end);
          throw $parseMinErr('lexerr', 'Lexer Error: {0} at column{1} in expression [{2}].', error, colStr, this.text);
        },
        readNumber: function() {
          var number = '';
          var start = this.index;
          while (this.index < this.text.length) {
            var ch = lowercase(this.text.charAt(this.index));
            if (ch == '.' || this.isNumber(ch)) {
              number += ch;
            } else {
              var peekCh = this.peek();
              if (ch == 'e' && this.isExpOperator(peekCh)) {
                number += ch;
              } else if (this.isExpOperator(ch) && peekCh && this.isNumber(peekCh) && number.charAt(number.length - 1) == 'e') {
                number += ch;
              } else if (this.isExpOperator(ch) && (!peekCh || !this.isNumber(peekCh)) && number.charAt(number.length - 1) == 'e') {
                this.throwError('Invalid exponent');
              } else {
                break;
              }
            }
            this.index++;
          }
          this.tokens.push({
            index: start,
            text: number,
            constant: true,
            value: Number(number)
          });
        },
        readIdent: function() {
          var start = this.index;
          while (this.index < this.text.length) {
            var ch = this.text.charAt(this.index);
            if (!(this.isIdent(ch) || this.isNumber(ch))) {
              break;
            }
            this.index++;
          }
          this.tokens.push({
            index: start,
            text: this.text.slice(start, this.index),
            identifier: true
          });
        },
        readString: function(quote) {
          var start = this.index;
          this.index++;
          var string = '';
          var rawString = quote;
          var escape = false;
          while (this.index < this.text.length) {
            var ch = this.text.charAt(this.index);
            rawString += ch;
            if (escape) {
              if (ch === 'u') {
                var hex = this.text.substring(this.index + 1, this.index + 5);
                if (!hex.match(/[\da-f]{4}/i)) {
                  this.throwError('Invalid unicode escape [\\u' + hex + ']');
                }
                this.index += 4;
                string += String.fromCharCode(parseInt(hex, 16));
              } else {
                var rep = ESCAPE[ch];
                string = string + (rep || ch);
              }
              escape = false;
            } else if (ch === '\\') {
              escape = true;
            } else if (ch === quote) {
              this.index++;
              this.tokens.push({
                index: start,
                text: rawString,
                constant: true,
                value: string
              });
              return ;
            } else {
              string += ch;
            }
            this.index++;
          }
          this.throwError('Unterminated quote', start);
        }
      };
      var AST = function(lexer, options) {
        this.lexer = lexer;
        this.options = options;
      };
      AST.Program = 'Program';
      AST.ExpressionStatement = 'ExpressionStatement';
      AST.AssignmentExpression = 'AssignmentExpression';
      AST.ConditionalExpression = 'ConditionalExpression';
      AST.LogicalExpression = 'LogicalExpression';
      AST.BinaryExpression = 'BinaryExpression';
      AST.UnaryExpression = 'UnaryExpression';
      AST.CallExpression = 'CallExpression';
      AST.MemberExpression = 'MemberExpression';
      AST.Identifier = 'Identifier';
      AST.Literal = 'Literal';
      AST.ArrayExpression = 'ArrayExpression';
      AST.Property = 'Property';
      AST.ObjectExpression = 'ObjectExpression';
      AST.ThisExpression = 'ThisExpression';
      AST.NGValueParameter = 'NGValueParameter';
      AST.prototype = {
        ast: function(text) {
          this.text = text;
          this.tokens = this.lexer.lex(text);
          var value = this.program();
          if (this.tokens.length !== 0) {
            this.throwError('is an unexpected token', this.tokens[0]);
          }
          return value;
        },
        program: function() {
          var body = [];
          while (true) {
            if (this.tokens.length > 0 && !this.peek('}', ')', ';', ']'))
              body.push(this.expressionStatement());
            if (!this.expect(';')) {
              return {
                type: AST.Program,
                body: body
              };
            }
          }
        },
        expressionStatement: function() {
          return {
            type: AST.ExpressionStatement,
            expression: this.filterChain()
          };
        },
        filterChain: function() {
          var left = this.expression();
          var token;
          while ((token = this.expect('|'))) {
            left = this.filter(left);
          }
          return left;
        },
        expression: function() {
          return this.assignment();
        },
        assignment: function() {
          var result = this.ternary();
          if (this.expect('=')) {
            result = {
              type: AST.AssignmentExpression,
              left: result,
              right: this.assignment(),
              operator: '='
            };
          }
          return result;
        },
        ternary: function() {
          var test = this.logicalOR();
          var alternate;
          var consequent;
          if (this.expect('?')) {
            alternate = this.expression();
            if (this.consume(':')) {
              consequent = this.expression();
              return {
                type: AST.ConditionalExpression,
                test: test,
                alternate: alternate,
                consequent: consequent
              };
            }
          }
          return test;
        },
        logicalOR: function() {
          var left = this.logicalAND();
          while (this.expect('||')) {
            left = {
              type: AST.LogicalExpression,
              operator: '||',
              left: left,
              right: this.logicalAND()
            };
          }
          return left;
        },
        logicalAND: function() {
          var left = this.equality();
          while (this.expect('&&')) {
            left = {
              type: AST.LogicalExpression,
              operator: '&&',
              left: left,
              right: this.equality()
            };
          }
          return left;
        },
        equality: function() {
          var left = this.relational();
          var token;
          while ((token = this.expect('==', '!=', '===', '!=='))) {
            left = {
              type: AST.BinaryExpression,
              operator: token.text,
              left: left,
              right: this.relational()
            };
          }
          return left;
        },
        relational: function() {
          var left = this.additive();
          var token;
          while ((token = this.expect('<', '>', '<=', '>='))) {
            left = {
              type: AST.BinaryExpression,
              operator: token.text,
              left: left,
              right: this.additive()
            };
          }
          return left;
        },
        additive: function() {
          var left = this.multiplicative();
          var token;
          while ((token = this.expect('+', '-'))) {
            left = {
              type: AST.BinaryExpression,
              operator: token.text,
              left: left,
              right: this.multiplicative()
            };
          }
          return left;
        },
        multiplicative: function() {
          var left = this.unary();
          var token;
          while ((token = this.expect('*', '/', '%'))) {
            left = {
              type: AST.BinaryExpression,
              operator: token.text,
              left: left,
              right: this.unary()
            };
          }
          return left;
        },
        unary: function() {
          var token;
          if ((token = this.expect('+', '-', '!'))) {
            return {
              type: AST.UnaryExpression,
              operator: token.text,
              prefix: true,
              argument: this.unary()
            };
          } else {
            return this.primary();
          }
        },
        primary: function() {
          var primary;
          if (this.expect('(')) {
            primary = this.filterChain();
            this.consume(')');
          } else if (this.expect('[')) {
            primary = this.arrayDeclaration();
          } else if (this.expect('{')) {
            primary = this.object();
          } else if (this.constants.hasOwnProperty(this.peek().text)) {
            primary = copy(this.constants[this.consume().text]);
          } else if (this.peek().identifier) {
            primary = this.identifier();
          } else if (this.peek().constant) {
            primary = this.constant();
          } else {
            this.throwError('not a primary expression', this.peek());
          }
          var next;
          while ((next = this.expect('(', '[', '.'))) {
            if (next.text === '(') {
              primary = {
                type: AST.CallExpression,
                callee: primary,
                arguments: this.parseArguments()
              };
              this.consume(')');
            } else if (next.text === '[') {
              primary = {
                type: AST.MemberExpression,
                object: primary,
                property: this.expression(),
                computed: true
              };
              this.consume(']');
            } else if (next.text === '.') {
              primary = {
                type: AST.MemberExpression,
                object: primary,
                property: this.identifier(),
                computed: false
              };
            } else {
              this.throwError('IMPOSSIBLE');
            }
          }
          return primary;
        },
        filter: function(baseExpression) {
          var args = [baseExpression];
          var result = {
            type: AST.CallExpression,
            callee: this.identifier(),
            arguments: args,
            filter: true
          };
          while (this.expect(':')) {
            args.push(this.expression());
          }
          return result;
        },
        parseArguments: function() {
          var args = [];
          if (this.peekToken().text !== ')') {
            do {
              args.push(this.expression());
            } while (this.expect(','));
          }
          return args;
        },
        identifier: function() {
          var token = this.consume();
          if (!token.identifier) {
            this.throwError('is not a valid identifier', token);
          }
          return {
            type: AST.Identifier,
            name: token.text
          };
        },
        constant: function() {
          return {
            type: AST.Literal,
            value: this.consume().value
          };
        },
        arrayDeclaration: function() {
          var elements = [];
          if (this.peekToken().text !== ']') {
            do {
              if (this.peek(']')) {
                break;
              }
              elements.push(this.expression());
            } while (this.expect(','));
          }
          this.consume(']');
          return {
            type: AST.ArrayExpression,
            elements: elements
          };
        },
        object: function() {
          var properties = [],
              property;
          if (this.peekToken().text !== '}') {
            do {
              if (this.peek('}')) {
                break;
              }
              property = {
                type: AST.Property,
                kind: 'init'
              };
              if (this.peek().constant) {
                property.key = this.constant();
              } else if (this.peek().identifier) {
                property.key = this.identifier();
              } else {
                this.throwError("invalid key", this.peek());
              }
              this.consume(':');
              property.value = this.expression();
              properties.push(property);
            } while (this.expect(','));
          }
          this.consume('}');
          return {
            type: AST.ObjectExpression,
            properties: properties
          };
        },
        throwError: function(msg, token) {
          throw $parseMinErr('syntax', 'Syntax Error: Token \'{0}\' {1} at column {2} of the expression [{3}] starting at [{4}].', token.text, msg, (token.index + 1), this.text, this.text.substring(token.index));
        },
        consume: function(e1) {
          if (this.tokens.length === 0) {
            throw $parseMinErr('ueoe', 'Unexpected end of expression: {0}', this.text);
          }
          var token = this.expect(e1);
          if (!token) {
            this.throwError('is unexpected, expecting [' + e1 + ']', this.peek());
          }
          return token;
        },
        peekToken: function() {
          if (this.tokens.length === 0) {
            throw $parseMinErr('ueoe', 'Unexpected end of expression: {0}', this.text);
          }
          return this.tokens[0];
        },
        peek: function(e1, e2, e3, e4) {
          return this.peekAhead(0, e1, e2, e3, e4);
        },
        peekAhead: function(i, e1, e2, e3, e4) {
          if (this.tokens.length > i) {
            var token = this.tokens[i];
            var t = token.text;
            if (t === e1 || t === e2 || t === e3 || t === e4 || (!e1 && !e2 && !e3 && !e4)) {
              return token;
            }
          }
          return false;
        },
        expect: function(e1, e2, e3, e4) {
          var token = this.peek(e1, e2, e3, e4);
          if (token) {
            this.tokens.shift();
            return token;
          }
          return false;
        },
        constants: {
          'true': {
            type: AST.Literal,
            value: true
          },
          'false': {
            type: AST.Literal,
            value: false
          },
          'null': {
            type: AST.Literal,
            value: null
          },
          'undefined': {
            type: AST.Literal,
            value: undefined
          },
          'this': {type: AST.ThisExpression}
        }
      };
      function ifDefined(v, d) {
        return typeof v !== 'undefined' ? v : d;
      }
      function plusFn(l, r) {
        if (typeof l === 'undefined')
          return r;
        if (typeof r === 'undefined')
          return l;
        return l + r;
      }
      function isStateless($filter, filterName) {
        var fn = $filter(filterName);
        return !fn.$stateful;
      }
      function findConstantAndWatchExpressions(ast, $filter) {
        var allConstants;
        var argsToWatch;
        switch (ast.type) {
          case AST.Program:
            allConstants = true;
            forEach(ast.body, function(expr) {
              findConstantAndWatchExpressions(expr.expression, $filter);
              allConstants = allConstants && expr.expression.constant;
            });
            ast.constant = allConstants;
            break;
          case AST.Literal:
            ast.constant = true;
            ast.toWatch = [];
            break;
          case AST.UnaryExpression:
            findConstantAndWatchExpressions(ast.argument, $filter);
            ast.constant = ast.argument.constant;
            ast.toWatch = ast.argument.toWatch;
            break;
          case AST.BinaryExpression:
            findConstantAndWatchExpressions(ast.left, $filter);
            findConstantAndWatchExpressions(ast.right, $filter);
            ast.constant = ast.left.constant && ast.right.constant;
            ast.toWatch = ast.left.toWatch.concat(ast.right.toWatch);
            break;
          case AST.LogicalExpression:
            findConstantAndWatchExpressions(ast.left, $filter);
            findConstantAndWatchExpressions(ast.right, $filter);
            ast.constant = ast.left.constant && ast.right.constant;
            ast.toWatch = ast.constant ? [] : [ast];
            break;
          case AST.ConditionalExpression:
            findConstantAndWatchExpressions(ast.test, $filter);
            findConstantAndWatchExpressions(ast.alternate, $filter);
            findConstantAndWatchExpressions(ast.consequent, $filter);
            ast.constant = ast.test.constant && ast.alternate.constant && ast.consequent.constant;
            ast.toWatch = ast.constant ? [] : [ast];
            break;
          case AST.Identifier:
            ast.constant = false;
            ast.toWatch = [ast];
            break;
          case AST.MemberExpression:
            findConstantAndWatchExpressions(ast.object, $filter);
            if (ast.computed) {
              findConstantAndWatchExpressions(ast.property, $filter);
            }
            ast.constant = ast.object.constant && (!ast.computed || ast.property.constant);
            ast.toWatch = [ast];
            break;
          case AST.CallExpression:
            allConstants = ast.filter ? isStateless($filter, ast.callee.name) : false;
            argsToWatch = [];
            forEach(ast.arguments, function(expr) {
              findConstantAndWatchExpressions(expr, $filter);
              allConstants = allConstants && expr.constant;
              if (!expr.constant) {
                argsToWatch.push.apply(argsToWatch, expr.toWatch);
              }
            });
            ast.constant = allConstants;
            ast.toWatch = ast.filter && isStateless($filter, ast.callee.name) ? argsToWatch : [ast];
            break;
          case AST.AssignmentExpression:
            findConstantAndWatchExpressions(ast.left, $filter);
            findConstantAndWatchExpressions(ast.right, $filter);
            ast.constant = ast.left.constant && ast.right.constant;
            ast.toWatch = [ast];
            break;
          case AST.ArrayExpression:
            allConstants = true;
            argsToWatch = [];
            forEach(ast.elements, function(expr) {
              findConstantAndWatchExpressions(expr, $filter);
              allConstants = allConstants && expr.constant;
              if (!expr.constant) {
                argsToWatch.push.apply(argsToWatch, expr.toWatch);
              }
            });
            ast.constant = allConstants;
            ast.toWatch = argsToWatch;
            break;
          case AST.ObjectExpression:
            allConstants = true;
            argsToWatch = [];
            forEach(ast.properties, function(property) {
              findConstantAndWatchExpressions(property.value, $filter);
              allConstants = allConstants && property.value.constant;
              if (!property.value.constant) {
                argsToWatch.push.apply(argsToWatch, property.value.toWatch);
              }
            });
            ast.constant = allConstants;
            ast.toWatch = argsToWatch;
            break;
          case AST.ThisExpression:
            ast.constant = false;
            ast.toWatch = [];
            break;
        }
      }
      function getInputs(body) {
        if (body.length != 1)
          return ;
        var lastExpression = body[0].expression;
        var candidate = lastExpression.toWatch;
        if (candidate.length !== 1)
          return candidate;
        return candidate[0] !== lastExpression ? candidate : undefined;
      }
      function isAssignable(ast) {
        return ast.type === AST.Identifier || ast.type === AST.MemberExpression;
      }
      function assignableAST(ast) {
        if (ast.body.length === 1 && isAssignable(ast.body[0].expression)) {
          return {
            type: AST.AssignmentExpression,
            left: ast.body[0].expression,
            right: {type: AST.NGValueParameter},
            operator: '='
          };
        }
      }
      function isLiteral(ast) {
        return ast.body.length === 0 || ast.body.length === 1 && (ast.body[0].expression.type === AST.Literal || ast.body[0].expression.type === AST.ArrayExpression || ast.body[0].expression.type === AST.ObjectExpression);
      }
      function isConstant(ast) {
        return ast.constant;
      }
      function ASTCompiler(astBuilder, $filter) {
        this.astBuilder = astBuilder;
        this.$filter = $filter;
      }
      ASTCompiler.prototype = {
        compile: function(expression, expensiveChecks) {
          var self = this;
          var ast = this.astBuilder.ast(expression);
          this.state = {
            nextId: 0,
            filters: {},
            expensiveChecks: expensiveChecks,
            fn: {
              vars: [],
              body: [],
              own: {}
            },
            assign: {
              vars: [],
              body: [],
              own: {}
            },
            inputs: []
          };
          findConstantAndWatchExpressions(ast, self.$filter);
          var extra = '';
          var assignable;
          this.stage = 'assign';
          if ((assignable = assignableAST(ast))) {
            this.state.computing = 'assign';
            var result = this.nextId();
            this.recurse(assignable, result);
            extra = 'fn.assign=' + this.generateFunction('assign', 's,v,l');
          }
          var toWatch = getInputs(ast.body);
          self.stage = 'inputs';
          forEach(toWatch, function(watch, key) {
            var fnKey = 'fn' + key;
            self.state[fnKey] = {
              vars: [],
              body: [],
              own: {}
            };
            self.state.computing = fnKey;
            var intoId = self.nextId();
            self.recurse(watch, intoId);
            self.return_(intoId);
            self.state.inputs.push(fnKey);
            watch.watchId = key;
          });
          this.state.computing = 'fn';
          this.stage = 'main';
          this.recurse(ast);
          var fnString = '"' + this.USE + ' ' + this.STRICT + '";\n' + this.filterPrefix() + 'var fn=' + this.generateFunction('fn', 's,l,a,i') + extra + this.watchFns() + 'return fn;';
          var fn = (new Function('$filter', 'ensureSafeMemberName', 'ensureSafeObject', 'ensureSafeFunction', 'ifDefined', 'plus', 'text', fnString))(this.$filter, ensureSafeMemberName, ensureSafeObject, ensureSafeFunction, ifDefined, plusFn, expression);
          this.state = this.stage = undefined;
          fn.literal = isLiteral(ast);
          fn.constant = isConstant(ast);
          return fn;
        },
        USE: 'use',
        STRICT: 'strict',
        watchFns: function() {
          var result = [];
          var fns = this.state.inputs;
          var self = this;
          forEach(fns, function(name) {
            result.push('var ' + name + '=' + self.generateFunction(name, 's'));
          });
          if (fns.length) {
            result.push('fn.inputs=[' + fns.join(',') + '];');
          }
          return result.join('');
        },
        generateFunction: function(name, params) {
          return 'function(' + params + '){' + this.varsPrefix(name) + this.body(name) + '};';
        },
        filterPrefix: function() {
          var parts = [];
          var self = this;
          forEach(this.state.filters, function(id, filter) {
            parts.push(id + '=$filter(' + self.escape(filter) + ')');
          });
          if (parts.length)
            return 'var ' + parts.join(',') + ';';
          return '';
        },
        varsPrefix: function(section) {
          return this.state[section].vars.length ? 'var ' + this.state[section].vars.join(',') + ';' : '';
        },
        body: function(section) {
          return this.state[section].body.join('');
        },
        recurse: function(ast, intoId, nameId, recursionFn, create, skipWatchIdCheck) {
          var left,
              right,
              self = this,
              args,
              expression;
          recursionFn = recursionFn || noop;
          if (!skipWatchIdCheck && isDefined(ast.watchId)) {
            intoId = intoId || this.nextId();
            this.if_('i', this.lazyAssign(intoId, this.computedMember('i', ast.watchId)), this.lazyRecurse(ast, intoId, nameId, recursionFn, create, true));
            return ;
          }
          switch (ast.type) {
            case AST.Program:
              forEach(ast.body, function(expression, pos) {
                self.recurse(expression.expression, undefined, undefined, function(expr) {
                  right = expr;
                });
                if (pos !== ast.body.length - 1) {
                  self.current().body.push(right, ';');
                } else {
                  self.return_(right);
                }
              });
              break;
            case AST.Literal:
              expression = this.escape(ast.value);
              this.assign(intoId, expression);
              recursionFn(expression);
              break;
            case AST.UnaryExpression:
              this.recurse(ast.argument, undefined, undefined, function(expr) {
                right = expr;
              });
              expression = ast.operator + '(' + this.ifDefined(right, 0) + ')';
              this.assign(intoId, expression);
              recursionFn(expression);
              break;
            case AST.BinaryExpression:
              this.recurse(ast.left, undefined, undefined, function(expr) {
                left = expr;
              });
              this.recurse(ast.right, undefined, undefined, function(expr) {
                right = expr;
              });
              if (ast.operator === '+') {
                expression = this.plus(left, right);
              } else if (ast.operator === '-') {
                expression = this.ifDefined(left, 0) + ast.operator + this.ifDefined(right, 0);
              } else {
                expression = '(' + left + ')' + ast.operator + '(' + right + ')';
              }
              this.assign(intoId, expression);
              recursionFn(expression);
              break;
            case AST.LogicalExpression:
              intoId = intoId || this.nextId();
              self.recurse(ast.left, intoId);
              self.if_(ast.operator === '&&' ? intoId : self.not(intoId), self.lazyRecurse(ast.right, intoId));
              recursionFn(intoId);
              break;
            case AST.ConditionalExpression:
              intoId = intoId || this.nextId();
              self.recurse(ast.test, intoId);
              self.if_(intoId, self.lazyRecurse(ast.alternate, intoId), self.lazyRecurse(ast.consequent, intoId));
              recursionFn(intoId);
              break;
            case AST.Identifier:
              intoId = intoId || this.nextId();
              if (nameId) {
                nameId.context = self.stage === 'inputs' ? 's' : this.assign(this.nextId(), this.getHasOwnProperty('l', ast.name) + '?l:s');
                nameId.computed = false;
                nameId.name = ast.name;
              }
              ensureSafeMemberName(ast.name);
              self.if_(self.stage === 'inputs' || self.not(self.getHasOwnProperty('l', ast.name)), function() {
                self.if_(self.stage === 'inputs' || 's', function() {
                  if (create && create !== 1) {
                    self.if_(self.not(self.nonComputedMember('s', ast.name)), self.lazyAssign(self.nonComputedMember('s', ast.name), '{}'));
                  }
                  self.assign(intoId, self.nonComputedMember('s', ast.name));
                });
              }, intoId && self.lazyAssign(intoId, self.nonComputedMember('l', ast.name)));
              if (self.state.expensiveChecks || isPossiblyDangerousMemberName(ast.name)) {
                self.addEnsureSafeObject(intoId);
              }
              recursionFn(intoId);
              break;
            case AST.MemberExpression:
              left = nameId && (nameId.context = this.nextId()) || this.nextId();
              intoId = intoId || this.nextId();
              self.recurse(ast.object, left, undefined, function() {
                self.if_(self.notNull(left), function() {
                  if (ast.computed) {
                    right = self.nextId();
                    self.recurse(ast.property, right);
                    self.addEnsureSafeMemberName(right);
                    if (create && create !== 1) {
                      self.if_(self.not(self.computedMember(left, right)), self.lazyAssign(self.computedMember(left, right), '{}'));
                    }
                    expression = self.ensureSafeObject(self.computedMember(left, right));
                    self.assign(intoId, expression);
                    if (nameId) {
                      nameId.computed = true;
                      nameId.name = right;
                    }
                  } else {
                    ensureSafeMemberName(ast.property.name);
                    if (create && create !== 1) {
                      self.if_(self.not(self.nonComputedMember(left, ast.property.name)), self.lazyAssign(self.nonComputedMember(left, ast.property.name), '{}'));
                    }
                    expression = self.nonComputedMember(left, ast.property.name);
                    if (self.state.expensiveChecks || isPossiblyDangerousMemberName(ast.property.name)) {
                      expression = self.ensureSafeObject(expression);
                    }
                    self.assign(intoId, expression);
                    if (nameId) {
                      nameId.computed = false;
                      nameId.name = ast.property.name;
                    }
                  }
                }, function() {
                  self.assign(intoId, 'undefined');
                });
                recursionFn(intoId);
              }, !!create);
              break;
            case AST.CallExpression:
              intoId = intoId || this.nextId();
              if (ast.filter) {
                right = self.filter(ast.callee.name);
                args = [];
                forEach(ast.arguments, function(expr) {
                  var argument = self.nextId();
                  self.recurse(expr, argument);
                  args.push(argument);
                });
                expression = right + '(' + args.join(',') + ')';
                self.assign(intoId, expression);
                recursionFn(intoId);
              } else {
                right = self.nextId();
                left = {};
                args = [];
                self.recurse(ast.callee, right, left, function() {
                  self.if_(self.notNull(right), function() {
                    self.addEnsureSafeFunction(right);
                    forEach(ast.arguments, function(expr) {
                      self.recurse(expr, self.nextId(), undefined, function(argument) {
                        args.push(self.ensureSafeObject(argument));
                      });
                    });
                    if (left.name) {
                      if (!self.state.expensiveChecks) {
                        self.addEnsureSafeObject(left.context);
                      }
                      expression = self.member(left.context, left.name, left.computed) + '(' + args.join(',') + ')';
                    } else {
                      expression = right + '(' + args.join(',') + ')';
                    }
                    expression = self.ensureSafeObject(expression);
                    self.assign(intoId, expression);
                  }, function() {
                    self.assign(intoId, 'undefined');
                  });
                  recursionFn(intoId);
                });
              }
              break;
            case AST.AssignmentExpression:
              right = this.nextId();
              left = {};
              if (!isAssignable(ast.left)) {
                throw $parseMinErr('lval', 'Trying to assing a value to a non l-value');
              }
              this.recurse(ast.left, undefined, left, function() {
                self.if_(self.notNull(left.context), function() {
                  self.recurse(ast.right, right);
                  self.addEnsureSafeObject(self.member(left.context, left.name, left.computed));
                  expression = self.member(left.context, left.name, left.computed) + ast.operator + right;
                  self.assign(intoId, expression);
                  recursionFn(intoId || expression);
                });
              }, 1);
              break;
            case AST.ArrayExpression:
              args = [];
              forEach(ast.elements, function(expr) {
                self.recurse(expr, self.nextId(), undefined, function(argument) {
                  args.push(argument);
                });
              });
              expression = '[' + args.join(',') + ']';
              this.assign(intoId, expression);
              recursionFn(expression);
              break;
            case AST.ObjectExpression:
              args = [];
              forEach(ast.properties, function(property) {
                self.recurse(property.value, self.nextId(), undefined, function(expr) {
                  args.push(self.escape(property.key.type === AST.Identifier ? property.key.name : ('' + property.key.value)) + ':' + expr);
                });
              });
              expression = '{' + args.join(',') + '}';
              this.assign(intoId, expression);
              recursionFn(expression);
              break;
            case AST.ThisExpression:
              this.assign(intoId, 's');
              recursionFn('s');
              break;
            case AST.NGValueParameter:
              this.assign(intoId, 'v');
              recursionFn('v');
              break;
          }
        },
        getHasOwnProperty: function(element, property) {
          var key = element + '.' + property;
          var own = this.current().own;
          if (!own.hasOwnProperty(key)) {
            own[key] = this.nextId(false, element + '&&(' + this.escape(property) + ' in ' + element + ')');
          }
          return own[key];
        },
        assign: function(id, value) {
          if (!id)
            return ;
          this.current().body.push(id, '=', value, ';');
          return id;
        },
        filter: function(filterName) {
          if (!this.state.filters.hasOwnProperty(filterName)) {
            this.state.filters[filterName] = this.nextId(true);
          }
          return this.state.filters[filterName];
        },
        ifDefined: function(id, defaultValue) {
          return 'ifDefined(' + id + ',' + this.escape(defaultValue) + ')';
        },
        plus: function(left, right) {
          return 'plus(' + left + ',' + right + ')';
        },
        return_: function(id) {
          this.current().body.push('return ', id, ';');
        },
        if_: function(test, alternate, consequent) {
          if (test === true) {
            alternate();
          } else {
            var body = this.current().body;
            body.push('if(', test, '){');
            alternate();
            body.push('}');
            if (consequent) {
              body.push('else{');
              consequent();
              body.push('}');
            }
          }
        },
        not: function(expression) {
          return '!(' + expression + ')';
        },
        notNull: function(expression) {
          return expression + '!=null';
        },
        nonComputedMember: function(left, right) {
          return left + '.' + right;
        },
        computedMember: function(left, right) {
          return left + '[' + right + ']';
        },
        member: function(left, right, computed) {
          if (computed)
            return this.computedMember(left, right);
          return this.nonComputedMember(left, right);
        },
        addEnsureSafeObject: function(item) {
          this.current().body.push(this.ensureSafeObject(item), ';');
        },
        addEnsureSafeMemberName: function(item) {
          this.current().body.push(this.ensureSafeMemberName(item), ';');
        },
        addEnsureSafeFunction: function(item) {
          this.current().body.push(this.ensureSafeFunction(item), ';');
        },
        ensureSafeObject: function(item) {
          return 'ensureSafeObject(' + item + ',text)';
        },
        ensureSafeMemberName: function(item) {
          return 'ensureSafeMemberName(' + item + ',text)';
        },
        ensureSafeFunction: function(item) {
          return 'ensureSafeFunction(' + item + ',text)';
        },
        lazyRecurse: function(ast, intoId, nameId, recursionFn, create, skipWatchIdCheck) {
          var self = this;
          return function() {
            self.recurse(ast, intoId, nameId, recursionFn, create, skipWatchIdCheck);
          };
        },
        lazyAssign: function(id, value) {
          var self = this;
          return function() {
            self.assign(id, value);
          };
        },
        stringEscapeRegex: /[^ a-zA-Z0-9]/g,
        stringEscapeFn: function(c) {
          return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
        },
        escape: function(value) {
          if (isString(value))
            return "'" + value.replace(this.stringEscapeRegex, this.stringEscapeFn) + "'";
          if (isNumber(value))
            return value.toString();
          if (value === true)
            return 'true';
          if (value === false)
            return 'false';
          if (value === null)
            return 'null';
          if (typeof value === 'undefined')
            return 'undefined';
          throw $parseMinErr('esc', 'IMPOSSIBLE');
        },
        nextId: function(skip, init) {
          var id = 'v' + (this.state.nextId++);
          if (!skip) {
            this.current().vars.push(id + (init ? '=' + init : ''));
          }
          return id;
        },
        current: function() {
          return this.state[this.state.computing];
        }
      };
      function ASTInterpreter(astBuilder, $filter) {
        this.astBuilder = astBuilder;
        this.$filter = $filter;
      }
      ASTInterpreter.prototype = {
        compile: function(expression, expensiveChecks) {
          var self = this;
          var ast = this.astBuilder.ast(expression);
          this.expression = expression;
          this.expensiveChecks = expensiveChecks;
          findConstantAndWatchExpressions(ast, self.$filter);
          var assignable;
          var assign;
          if ((assignable = assignableAST(ast))) {
            assign = this.recurse(assignable);
          }
          var toWatch = getInputs(ast.body);
          var inputs;
          if (toWatch) {
            inputs = [];
            forEach(toWatch, function(watch, key) {
              var input = self.recurse(watch);
              watch.input = input;
              inputs.push(input);
              watch.watchId = key;
            });
          }
          var expressions = [];
          forEach(ast.body, function(expression) {
            expressions.push(self.recurse(expression.expression));
          });
          var fn = ast.body.length === 0 ? function() {} : ast.body.length === 1 ? expressions[0] : function(scope, locals) {
            var lastValue;
            forEach(expressions, function(exp) {
              lastValue = exp(scope, locals);
            });
            return lastValue;
          };
          if (assign) {
            fn.assign = function(scope, value, locals) {
              return assign(scope, locals, value);
            };
          }
          if (inputs) {
            fn.inputs = inputs;
          }
          fn.literal = isLiteral(ast);
          fn.constant = isConstant(ast);
          return fn;
        },
        recurse: function(ast, context, create) {
          var left,
              right,
              self = this,
              args,
              expression;
          if (ast.input) {
            return this.inputs(ast.input, ast.watchId);
          }
          switch (ast.type) {
            case AST.Literal:
              return this.value(ast.value, context);
            case AST.UnaryExpression:
              right = this.recurse(ast.argument);
              return this['unary' + ast.operator](right, context);
            case AST.BinaryExpression:
              left = this.recurse(ast.left);
              right = this.recurse(ast.right);
              return this['binary' + ast.operator](left, right, context);
            case AST.LogicalExpression:
              left = this.recurse(ast.left);
              right = this.recurse(ast.right);
              return this['binary' + ast.operator](left, right, context);
            case AST.ConditionalExpression:
              return this['ternary?:'](this.recurse(ast.test), this.recurse(ast.alternate), this.recurse(ast.consequent), context);
            case AST.Identifier:
              ensureSafeMemberName(ast.name, self.expression);
              return self.identifier(ast.name, self.expensiveChecks || isPossiblyDangerousMemberName(ast.name), context, create, self.expression);
            case AST.MemberExpression:
              left = this.recurse(ast.object, false, !!create);
              if (!ast.computed) {
                ensureSafeMemberName(ast.property.name, self.expression);
                right = ast.property.name;
              }
              if (ast.computed)
                right = this.recurse(ast.property);
              return ast.computed ? this.computedMember(left, right, context, create, self.expression) : this.nonComputedMember(left, right, self.expensiveChecks, context, create, self.expression);
            case AST.CallExpression:
              args = [];
              forEach(ast.arguments, function(expr) {
                args.push(self.recurse(expr));
              });
              if (ast.filter)
                right = this.$filter(ast.callee.name);
              if (!ast.filter)
                right = this.recurse(ast.callee, true);
              return ast.filter ? function(scope, locals, assign, inputs) {
                var values = [];
                for (var i = 0; i < args.length; ++i) {
                  values.push(args[i](scope, locals, assign, inputs));
                }
                var value = right.apply(undefined, values, inputs);
                return context ? {
                  context: undefined,
                  name: undefined,
                  value: value
                } : value;
              } : function(scope, locals, assign, inputs) {
                var rhs = right(scope, locals, assign, inputs);
                var value;
                if (rhs.value != null) {
                  ensureSafeObject(rhs.context, self.expression);
                  ensureSafeFunction(rhs.value, self.expression);
                  var values = [];
                  for (var i = 0; i < args.length; ++i) {
                    values.push(ensureSafeObject(args[i](scope, locals, assign, inputs), self.expression));
                  }
                  value = ensureSafeObject(rhs.value.apply(rhs.context, values), self.expression);
                }
                return context ? {value: value} : value;
              };
            case AST.AssignmentExpression:
              left = this.recurse(ast.left, true, 1);
              right = this.recurse(ast.right);
              return function(scope, locals, assign, inputs) {
                var lhs = left(scope, locals, assign, inputs);
                var rhs = right(scope, locals, assign, inputs);
                ensureSafeObject(lhs.value, self.expression);
                lhs.context[lhs.name] = rhs;
                return context ? {value: rhs} : rhs;
              };
            case AST.ArrayExpression:
              args = [];
              forEach(ast.elements, function(expr) {
                args.push(self.recurse(expr));
              });
              return function(scope, locals, assign, inputs) {
                var value = [];
                for (var i = 0; i < args.length; ++i) {
                  value.push(args[i](scope, locals, assign, inputs));
                }
                return context ? {value: value} : value;
              };
            case AST.ObjectExpression:
              args = [];
              forEach(ast.properties, function(property) {
                args.push({
                  key: property.key.type === AST.Identifier ? property.key.name : ('' + property.key.value),
                  value: self.recurse(property.value)
                });
              });
              return function(scope, locals, assign, inputs) {
                var value = {};
                for (var i = 0; i < args.length; ++i) {
                  value[args[i].key] = args[i].value(scope, locals, assign, inputs);
                }
                return context ? {value: value} : value;
              };
            case AST.ThisExpression:
              return function(scope) {
                return context ? {value: scope} : scope;
              };
            case AST.NGValueParameter:
              return function(scope, locals, assign, inputs) {
                return context ? {value: assign} : assign;
              };
          }
        },
        'unary+': function(argument, context) {
          return function(scope, locals, assign, inputs) {
            var arg = argument(scope, locals, assign, inputs);
            if (isDefined(arg)) {
              arg = +arg;
            } else {
              arg = 0;
            }
            return context ? {value: arg} : arg;
          };
        },
        'unary-': function(argument, context) {
          return function(scope, locals, assign, inputs) {
            var arg = argument(scope, locals, assign, inputs);
            if (isDefined(arg)) {
              arg = -arg;
            } else {
              arg = 0;
            }
            return context ? {value: arg} : arg;
          };
        },
        'unary!': function(argument, context) {
          return function(scope, locals, assign, inputs) {
            var arg = !argument(scope, locals, assign, inputs);
            return context ? {value: arg} : arg;
          };
        },
        'binary+': function(left, right, context) {
          return function(scope, locals, assign, inputs) {
            var lhs = left(scope, locals, assign, inputs);
            var rhs = right(scope, locals, assign, inputs);
            var arg = plusFn(lhs, rhs);
            return context ? {value: arg} : arg;
          };
        },
        'binary-': function(left, right, context) {
          return function(scope, locals, assign, inputs) {
            var lhs = left(scope, locals, assign, inputs);
            var rhs = right(scope, locals, assign, inputs);
            var arg = (isDefined(lhs) ? lhs : 0) - (isDefined(rhs) ? rhs : 0);
            return context ? {value: arg} : arg;
          };
        },
        'binary*': function(left, right, context) {
          return function(scope, locals, assign, inputs) {
            var arg = left(scope, locals, assign, inputs) * right(scope, locals, assign, inputs);
            return context ? {value: arg} : arg;
          };
        },
        'binary/': function(left, right, context) {
          return function(scope, locals, assign, inputs) {
            var arg = left(scope, locals, assign, inputs) / right(scope, locals, assign, inputs);
            return context ? {value: arg} : arg;
          };
        },
        'binary%': function(left, right, context) {
          return function(scope, locals, assign, inputs) {
            var arg = left(scope, locals, assign, inputs) % right(scope, locals, assign, inputs);
            return context ? {value: arg} : arg;
          };
        },
        'binary===': function(left, right, context) {
          return function(scope, locals, assign, inputs) {
            var arg = left(scope, locals, assign, inputs) === right(scope, locals, assign, inputs);
            return context ? {value: arg} : arg;
          };
        },
        'binary!==': function(left, right, context) {
          return function(scope, locals, assign, inputs) {
            var arg = left(scope, locals, assign, inputs) !== right(scope, locals, assign, inputs);
            return context ? {value: arg} : arg;
          };
        },
        'binary==': function(left, right, context) {
          return function(scope, locals, assign, inputs) {
            var arg = left(scope, locals, assign, inputs) == right(scope, locals, assign, inputs);
            return context ? {value: arg} : arg;
          };
        },
        'binary!=': function(left, right, context) {
          return function(scope, locals, assign, inputs) {
            var arg = left(scope, locals, assign, inputs) != right(scope, locals, assign, inputs);
            return context ? {value: arg} : arg;
          };
        },
        'binary<': function(left, right, context) {
          return function(scope, locals, assign, inputs) {
            var arg = left(scope, locals, assign, inputs) < right(scope, locals, assign, inputs);
            return context ? {value: arg} : arg;
          };
        },
        'binary>': function(left, right, context) {
          return function(scope, locals, assign, inputs) {
            var arg = left(scope, locals, assign, inputs) > right(scope, locals, assign, inputs);
            return context ? {value: arg} : arg;
          };
        },
        'binary<=': function(left, right, context) {
          return function(scope, locals, assign, inputs) {
            var arg = left(scope, locals, assign, inputs) <= right(scope, locals, assign, inputs);
            return context ? {value: arg} : arg;
          };
        },
        'binary>=': function(left, right, context) {
          return function(scope, locals, assign, inputs) {
            var arg = left(scope, locals, assign, inputs) >= right(scope, locals, assign, inputs);
            return context ? {value: arg} : arg;
          };
        },
        'binary&&': function(left, right, context) {
          return function(scope, locals, assign, inputs) {
            var arg = left(scope, locals, assign, inputs) && right(scope, locals, assign, inputs);
            return context ? {value: arg} : arg;
          };
        },
        'binary||': function(left, right, context) {
          return function(scope, locals, assign, inputs) {
            var arg = left(scope, locals, assign, inputs) || right(scope, locals, assign, inputs);
            return context ? {value: arg} : arg;
          };
        },
        'ternary?:': function(test, alternate, consequent, context) {
          return function(scope, locals, assign, inputs) {
            var arg = test(scope, locals, assign, inputs) ? alternate(scope, locals, assign, inputs) : consequent(scope, locals, assign, inputs);
            return context ? {value: arg} : arg;
          };
        },
        value: function(value, context) {
          return function() {
            return context ? {
              context: undefined,
              name: undefined,
              value: value
            } : value;
          };
        },
        identifier: function(name, expensiveChecks, context, create, expression) {
          return function(scope, locals, assign, inputs) {
            var base = locals && (name in locals) ? locals : scope;
            if (create && create !== 1 && base && !(base[name])) {
              base[name] = {};
            }
            var value = base ? base[name] : undefined;
            if (expensiveChecks) {
              ensureSafeObject(value, expression);
            }
            if (context) {
              return {
                context: base,
                name: name,
                value: value
              };
            } else {
              return value;
            }
          };
        },
        computedMember: function(left, right, context, create, expression) {
          return function(scope, locals, assign, inputs) {
            var lhs = left(scope, locals, assign, inputs);
            var rhs;
            var value;
            if (lhs != null) {
              rhs = right(scope, locals, assign, inputs);
              ensureSafeMemberName(rhs, expression);
              if (create && create !== 1 && lhs && !(lhs[rhs])) {
                lhs[rhs] = {};
              }
              value = lhs[rhs];
              ensureSafeObject(value, expression);
            }
            if (context) {
              return {
                context: lhs,
                name: rhs,
                value: value
              };
            } else {
              return value;
            }
          };
        },
        nonComputedMember: function(left, right, expensiveChecks, context, create, expression) {
          return function(scope, locals, assign, inputs) {
            var lhs = left(scope, locals, assign, inputs);
            if (create && create !== 1 && lhs && !(lhs[right])) {
              lhs[right] = {};
            }
            var value = lhs != null ? lhs[right] : undefined;
            if (expensiveChecks || isPossiblyDangerousMemberName(right)) {
              ensureSafeObject(value, expression);
            }
            if (context) {
              return {
                context: lhs,
                name: right,
                value: value
              };
            } else {
              return value;
            }
          };
        },
        inputs: function(input, watchId) {
          return function(scope, value, locals, inputs) {
            if (inputs)
              return inputs[watchId];
            return input(scope, value, locals);
          };
        }
      };
      var Parser = function(lexer, $filter, options) {
        this.lexer = lexer;
        this.$filter = $filter;
        this.options = options;
        this.ast = new AST(this.lexer);
        this.astCompiler = options.csp ? new ASTInterpreter(this.ast, $filter) : new ASTCompiler(this.ast, $filter);
      };
      Parser.prototype = {
        constructor: Parser,
        parse: function(text) {
          return this.astCompiler.compile(text, this.options.expensiveChecks);
        }
      };
      function setter(obj, path, setValue, fullExp) {
        ensureSafeObject(obj, fullExp);
        var element = path.split('.'),
            key;
        for (var i = 0; element.length > 1; i++) {
          key = ensureSafeMemberName(element.shift(), fullExp);
          var propertyObj = ensureSafeObject(obj[key], fullExp);
          if (!propertyObj) {
            propertyObj = {};
            obj[key] = propertyObj;
          }
          obj = propertyObj;
        }
        key = ensureSafeMemberName(element.shift(), fullExp);
        ensureSafeObject(obj[key], fullExp);
        obj[key] = setValue;
        return setValue;
      }
      var getterFnCacheDefault = createMap();
      var getterFnCacheExpensive = createMap();
      function isPossiblyDangerousMemberName(name) {
        return name == 'constructor';
      }
      var objectValueOf = Object.prototype.valueOf;
      function getValueOf(value) {
        return isFunction(value.valueOf) ? value.valueOf() : objectValueOf.call(value);
      }
      function $ParseProvider() {
        var cacheDefault = createMap();
        var cacheExpensive = createMap();
        this.$get = ['$filter', '$sniffer', function($filter, $sniffer) {
          var $parseOptions = {
            csp: $sniffer.csp,
            expensiveChecks: false
          },
              $parseOptionsExpensive = {
                csp: $sniffer.csp,
                expensiveChecks: true
              };
          return function $parse(exp, interceptorFn, expensiveChecks) {
            var parsedExpression,
                oneTime,
                cacheKey;
            switch (typeof exp) {
              case 'string':
                exp = exp.trim();
                cacheKey = exp;
                var cache = (expensiveChecks ? cacheExpensive : cacheDefault);
                parsedExpression = cache[cacheKey];
                if (!parsedExpression) {
                  if (exp.charAt(0) === ':' && exp.charAt(1) === ':') {
                    oneTime = true;
                    exp = exp.substring(2);
                  }
                  var parseOptions = expensiveChecks ? $parseOptionsExpensive : $parseOptions;
                  var lexer = new Lexer(parseOptions);
                  var parser = new Parser(lexer, $filter, parseOptions);
                  parsedExpression = parser.parse(exp);
                  if (parsedExpression.constant) {
                    parsedExpression.$$watchDelegate = constantWatchDelegate;
                  } else if (oneTime) {
                    parsedExpression.$$watchDelegate = parsedExpression.literal ? oneTimeLiteralWatchDelegate : oneTimeWatchDelegate;
                  } else if (parsedExpression.inputs) {
                    parsedExpression.$$watchDelegate = inputsWatchDelegate;
                  }
                  cache[cacheKey] = parsedExpression;
                }
                return addInterceptor(parsedExpression, interceptorFn);
              case 'function':
                return addInterceptor(exp, interceptorFn);
              default:
                return noop;
            }
          };
          function expressionInputDirtyCheck(newValue, oldValueOfValue) {
            if (newValue == null || oldValueOfValue == null) {
              return newValue === oldValueOfValue;
            }
            if (typeof newValue === 'object') {
              newValue = getValueOf(newValue);
              if (typeof newValue === 'object') {
                return false;
              }
            }
            return newValue === oldValueOfValue || (newValue !== newValue && oldValueOfValue !== oldValueOfValue);
          }
          function inputsWatchDelegate(scope, listener, objectEquality, parsedExpression, prettyPrintExpression) {
            var inputExpressions = parsedExpression.inputs;
            var lastResult;
            if (inputExpressions.length === 1) {
              var oldInputValueOf = expressionInputDirtyCheck;
              inputExpressions = inputExpressions[0];
              return scope.$watch(function expressionInputWatch(scope) {
                var newInputValue = inputExpressions(scope);
                if (!expressionInputDirtyCheck(newInputValue, oldInputValueOf)) {
                  lastResult = parsedExpression(scope, undefined, undefined, [newInputValue]);
                  oldInputValueOf = newInputValue && getValueOf(newInputValue);
                }
                return lastResult;
              }, listener, objectEquality, prettyPrintExpression);
            }
            var oldInputValueOfValues = [];
            var oldInputValues = [];
            for (var i = 0,
                ii = inputExpressions.length; i < ii; i++) {
              oldInputValueOfValues[i] = expressionInputDirtyCheck;
              oldInputValues[i] = null;
            }
            return scope.$watch(function expressionInputsWatch(scope) {
              var changed = false;
              for (var i = 0,
                  ii = inputExpressions.length; i < ii; i++) {
                var newInputValue = inputExpressions[i](scope);
                if (changed || (changed = !expressionInputDirtyCheck(newInputValue, oldInputValueOfValues[i]))) {
                  oldInputValues[i] = newInputValue;
                  oldInputValueOfValues[i] = newInputValue && getValueOf(newInputValue);
                }
              }
              if (changed) {
                lastResult = parsedExpression(scope, undefined, undefined, oldInputValues);
              }
              return lastResult;
            }, listener, objectEquality, prettyPrintExpression);
          }
          function oneTimeWatchDelegate(scope, listener, objectEquality, parsedExpression) {
            var unwatch,
                lastValue;
            return unwatch = scope.$watch(function oneTimeWatch(scope) {
              return parsedExpression(scope);
            }, function oneTimeListener(value, old, scope) {
              lastValue = value;
              if (isFunction(listener)) {
                listener.apply(this, arguments);
              }
              if (isDefined(value)) {
                scope.$$postDigest(function() {
                  if (isDefined(lastValue)) {
                    unwatch();
                  }
                });
              }
            }, objectEquality);
          }
          function oneTimeLiteralWatchDelegate(scope, listener, objectEquality, parsedExpression) {
            var unwatch,
                lastValue;
            return unwatch = scope.$watch(function oneTimeWatch(scope) {
              return parsedExpression(scope);
            }, function oneTimeListener(value, old, scope) {
              lastValue = value;
              if (isFunction(listener)) {
                listener.call(this, value, old, scope);
              }
              if (isAllDefined(value)) {
                scope.$$postDigest(function() {
                  if (isAllDefined(lastValue))
                    unwatch();
                });
              }
            }, objectEquality);
            function isAllDefined(value) {
              var allDefined = true;
              forEach(value, function(val) {
                if (!isDefined(val))
                  allDefined = false;
              });
              return allDefined;
            }
          }
          function constantWatchDelegate(scope, listener, objectEquality, parsedExpression) {
            var unwatch;
            return unwatch = scope.$watch(function constantWatch(scope) {
              return parsedExpression(scope);
            }, function constantListener(value, old, scope) {
              if (isFunction(listener)) {
                listener.apply(this, arguments);
              }
              unwatch();
            }, objectEquality);
          }
          function addInterceptor(parsedExpression, interceptorFn) {
            if (!interceptorFn)
              return parsedExpression;
            var watchDelegate = parsedExpression.$$watchDelegate;
            var regularWatch = watchDelegate !== oneTimeLiteralWatchDelegate && watchDelegate !== oneTimeWatchDelegate;
            var fn = regularWatch ? function regularInterceptedExpression(scope, locals, assign, inputs) {
              var value = parsedExpression(scope, locals, assign, inputs);
              return interceptorFn(value, scope, locals);
            } : function oneTimeInterceptedExpression(scope, locals, assign, inputs) {
              var value = parsedExpression(scope, locals, assign, inputs);
              var result = interceptorFn(value, scope, locals);
              return isDefined(value) ? result : value;
            };
            if (parsedExpression.$$watchDelegate && parsedExpression.$$watchDelegate !== inputsWatchDelegate) {
              fn.$$watchDelegate = parsedExpression.$$watchDelegate;
            } else if (!interceptorFn.$stateful) {
              fn.$$watchDelegate = inputsWatchDelegate;
              fn.inputs = parsedExpression.inputs ? parsedExpression.inputs : [parsedExpression];
            }
            return fn;
          }
        }];
      }
      function $QProvider() {
        this.$get = ['$rootScope', '$exceptionHandler', function($rootScope, $exceptionHandler) {
          return qFactory(function(callback) {
            $rootScope.$evalAsync(callback);
          }, $exceptionHandler);
        }];
      }
      function $$QProvider() {
        this.$get = ['$browser', '$exceptionHandler', function($browser, $exceptionHandler) {
          return qFactory(function(callback) {
            $browser.defer(callback);
          }, $exceptionHandler);
        }];
      }
      function qFactory(nextTick, exceptionHandler) {
        var $qMinErr = minErr('$q', TypeError);
        function callOnce(self, resolveFn, rejectFn) {
          var called = false;
          function wrap(fn) {
            return function(value) {
              if (called)
                return ;
              called = true;
              fn.call(self, value);
            };
          }
          return [wrap(resolveFn), wrap(rejectFn)];
        }
        var defer = function() {
          return new Deferred();
        };
        function Promise() {
          this.$$state = {status: 0};
        }
        Promise.prototype = {
          then: function(onFulfilled, onRejected, progressBack) {
            var result = new Deferred();
            this.$$state.pending = this.$$state.pending || [];
            this.$$state.pending.push([result, onFulfilled, onRejected, progressBack]);
            if (this.$$state.status > 0)
              scheduleProcessQueue(this.$$state);
            return result.promise;
          },
          "catch": function(callback) {
            return this.then(null, callback);
          },
          "finally": function(callback, progressBack) {
            return this.then(function(value) {
              return handleCallback(value, true, callback);
            }, function(error) {
              return handleCallback(error, false, callback);
            }, progressBack);
          }
        };
        function simpleBind(context, fn) {
          return function(value) {
            fn.call(context, value);
          };
        }
        function processQueue(state) {
          var fn,
              deferred,
              pending;
          pending = state.pending;
          state.processScheduled = false;
          state.pending = undefined;
          for (var i = 0,
              ii = pending.length; i < ii; ++i) {
            deferred = pending[i][0];
            fn = pending[i][state.status];
            try {
              if (isFunction(fn)) {
                deferred.resolve(fn(state.value));
              } else if (state.status === 1) {
                deferred.resolve(state.value);
              } else {
                deferred.reject(state.value);
              }
            } catch (e) {
              deferred.reject(e);
              exceptionHandler(e);
            }
          }
        }
        function scheduleProcessQueue(state) {
          if (state.processScheduled || !state.pending)
            return ;
          state.processScheduled = true;
          nextTick(function() {
            processQueue(state);
          });
        }
        function Deferred() {
          this.promise = new Promise();
          this.resolve = simpleBind(this, this.resolve);
          this.reject = simpleBind(this, this.reject);
          this.notify = simpleBind(this, this.notify);
        }
        Deferred.prototype = {
          resolve: function(val) {
            if (this.promise.$$state.status)
              return ;
            if (val === this.promise) {
              this.$$reject($qMinErr('qcycle', "Expected promise to be resolved with value other than itself '{0}'", val));
            } else {
              this.$$resolve(val);
            }
          },
          $$resolve: function(val) {
            var then,
                fns;
            fns = callOnce(this, this.$$resolve, this.$$reject);
            try {
              if ((isObject(val) || isFunction(val)))
                then = val && val.then;
              if (isFunction(then)) {
                this.promise.$$state.status = -1;
                then.call(val, fns[0], fns[1], this.notify);
              } else {
                this.promise.$$state.value = val;
                this.promise.$$state.status = 1;
                scheduleProcessQueue(this.promise.$$state);
              }
            } catch (e) {
              fns[1](e);
              exceptionHandler(e);
            }
          },
          reject: function(reason) {
            if (this.promise.$$state.status)
              return ;
            this.$$reject(reason);
          },
          $$reject: function(reason) {
            this.promise.$$state.value = reason;
            this.promise.$$state.status = 2;
            scheduleProcessQueue(this.promise.$$state);
          },
          notify: function(progress) {
            var callbacks = this.promise.$$state.pending;
            if ((this.promise.$$state.status <= 0) && callbacks && callbacks.length) {
              nextTick(function() {
                var callback,
                    result;
                for (var i = 0,
                    ii = callbacks.length; i < ii; i++) {
                  result = callbacks[i][0];
                  callback = callbacks[i][3];
                  try {
                    result.notify(isFunction(callback) ? callback(progress) : progress);
                  } catch (e) {
                    exceptionHandler(e);
                  }
                }
              });
            }
          }
        };
        var reject = function(reason) {
          var result = new Deferred();
          result.reject(reason);
          return result.promise;
        };
        var makePromise = function makePromise(value, resolved) {
          var result = new Deferred();
          if (resolved) {
            result.resolve(value);
          } else {
            result.reject(value);
          }
          return result.promise;
        };
        var handleCallback = function handleCallback(value, isResolved, callback) {
          var callbackOutput = null;
          try {
            if (isFunction(callback))
              callbackOutput = callback();
          } catch (e) {
            return makePromise(e, false);
          }
          if (isPromiseLike(callbackOutput)) {
            return callbackOutput.then(function() {
              return makePromise(value, isResolved);
            }, function(error) {
              return makePromise(error, false);
            });
          } else {
            return makePromise(value, isResolved);
          }
        };
        var when = function(value, callback, errback, progressBack) {
          var result = new Deferred();
          result.resolve(value);
          return result.promise.then(callback, errback, progressBack);
        };
        var resolve = when;
        function all(promises) {
          var deferred = new Deferred(),
              counter = 0,
              results = isArray(promises) ? [] : {};
          forEach(promises, function(promise, key) {
            counter++;
            when(promise).then(function(value) {
              if (results.hasOwnProperty(key))
                return ;
              results[key] = value;
              if (!(--counter))
                deferred.resolve(results);
            }, function(reason) {
              if (results.hasOwnProperty(key))
                return ;
              deferred.reject(reason);
            });
          });
          if (counter === 0) {
            deferred.resolve(results);
          }
          return deferred.promise;
        }
        var $Q = function Q(resolver) {
          if (!isFunction(resolver)) {
            throw $qMinErr('norslvr', "Expected resolverFn, got '{0}'", resolver);
          }
          if (!(this instanceof Q)) {
            return new Q(resolver);
          }
          var deferred = new Deferred();
          function resolveFn(value) {
            deferred.resolve(value);
          }
          function rejectFn(reason) {
            deferred.reject(reason);
          }
          resolver(resolveFn, rejectFn);
          return deferred.promise;
        };
        $Q.defer = defer;
        $Q.reject = reject;
        $Q.when = when;
        $Q.resolve = resolve;
        $Q.all = all;
        return $Q;
      }
      function $$RAFProvider() {
        this.$get = ['$window', '$timeout', function($window, $timeout) {
          var requestAnimationFrame = $window.requestAnimationFrame || $window.webkitRequestAnimationFrame;
          var cancelAnimationFrame = $window.cancelAnimationFrame || $window.webkitCancelAnimationFrame || $window.webkitCancelRequestAnimationFrame;
          var rafSupported = !!requestAnimationFrame;
          var rafFn = rafSupported ? function(fn) {
            var id = requestAnimationFrame(fn);
            return function() {
              cancelAnimationFrame(id);
            };
          } : function(fn) {
            var timer = $timeout(fn, 16.66, false);
            return function() {
              $timeout.cancel(timer);
            };
          };
          queueFn.supported = rafSupported;
          var cancelLastRAF;
          var taskCount = 0;
          var taskQueue = [];
          return queueFn;
          function flush() {
            for (var i = 0; i < taskQueue.length; i++) {
              var task = taskQueue[i];
              if (task) {
                taskQueue[i] = null;
                task();
              }
            }
            taskCount = taskQueue.length = 0;
          }
          function queueFn(asyncFn) {
            var index = taskQueue.length;
            taskCount++;
            taskQueue.push(asyncFn);
            if (index === 0) {
              cancelLastRAF = rafFn(flush);
            }
            return function cancelQueueFn() {
              if (index >= 0) {
                taskQueue[index] = null;
                index = null;
                if (--taskCount === 0 && cancelLastRAF) {
                  cancelLastRAF();
                  cancelLastRAF = null;
                  taskQueue.length = 0;
                }
              }
            };
          }
        }];
      }
      function $RootScopeProvider() {
        var TTL = 10;
        var $rootScopeMinErr = minErr('$rootScope');
        var lastDirtyWatch = null;
        var applyAsyncId = null;
        this.digestTtl = function(value) {
          if (arguments.length) {
            TTL = value;
          }
          return TTL;
        };
        function createChildScopeClass(parent) {
          function ChildScope() {
            this.$$watchers = this.$$nextSibling = this.$$childHead = this.$$childTail = null;
            this.$$listeners = {};
            this.$$listenerCount = {};
            this.$$watchersCount = 0;
            this.$id = nextUid();
            this.$$ChildScope = null;
          }
          ChildScope.prototype = parent;
          return ChildScope;
        }
        this.$get = ['$injector', '$exceptionHandler', '$parse', '$browser', function($injector, $exceptionHandler, $parse, $browser) {
          function destroyChildScope($event) {
            $event.currentScope.$$destroyed = true;
          }
          function Scope() {
            this.$id = nextUid();
            this.$$phase = this.$parent = this.$$watchers = this.$$nextSibling = this.$$prevSibling = this.$$childHead = this.$$childTail = null;
            this.$root = this;
            this.$$destroyed = false;
            this.$$listeners = {};
            this.$$listenerCount = {};
            this.$$watchersCount = 0;
            this.$$isolateBindings = null;
          }
          Scope.prototype = {
            constructor: Scope,
            $new: function(isolate, parent) {
              var child;
              parent = parent || this;
              if (isolate) {
                child = new Scope();
                child.$root = this.$root;
              } else {
                if (!this.$$ChildScope) {
                  this.$$ChildScope = createChildScopeClass(this);
                }
                child = new this.$$ChildScope();
              }
              child.$parent = parent;
              child.$$prevSibling = parent.$$childTail;
              if (parent.$$childHead) {
                parent.$$childTail.$$nextSibling = child;
                parent.$$childTail = child;
              } else {
                parent.$$childHead = parent.$$childTail = child;
              }
              if (isolate || parent != this)
                child.$on('$destroy', destroyChildScope);
              return child;
            },
            $watch: function(watchExp, listener, objectEquality, prettyPrintExpression) {
              var get = $parse(watchExp);
              if (get.$$watchDelegate) {
                return get.$$watchDelegate(this, listener, objectEquality, get, watchExp);
              }
              var scope = this,
                  array = scope.$$watchers,
                  watcher = {
                    fn: listener,
                    last: initWatchVal,
                    get: get,
                    exp: prettyPrintExpression || watchExp,
                    eq: !!objectEquality
                  };
              lastDirtyWatch = null;
              if (!isFunction(listener)) {
                watcher.fn = noop;
              }
              if (!array) {
                array = scope.$$watchers = [];
              }
              array.unshift(watcher);
              incrementWatchersCount(this, 1);
              return function deregisterWatch() {
                if (arrayRemove(array, watcher) >= 0) {
                  incrementWatchersCount(scope, -1);
                }
                lastDirtyWatch = null;
              };
            },
            $watchGroup: function(watchExpressions, listener) {
              var oldValues = new Array(watchExpressions.length);
              var newValues = new Array(watchExpressions.length);
              var deregisterFns = [];
              var self = this;
              var changeReactionScheduled = false;
              var firstRun = true;
              if (!watchExpressions.length) {
                var shouldCall = true;
                self.$evalAsync(function() {
                  if (shouldCall)
                    listener(newValues, newValues, self);
                });
                return function deregisterWatchGroup() {
                  shouldCall = false;
                };
              }
              if (watchExpressions.length === 1) {
                return this.$watch(watchExpressions[0], function watchGroupAction(value, oldValue, scope) {
                  newValues[0] = value;
                  oldValues[0] = oldValue;
                  listener(newValues, (value === oldValue) ? newValues : oldValues, scope);
                });
              }
              forEach(watchExpressions, function(expr, i) {
                var unwatchFn = self.$watch(expr, function watchGroupSubAction(value, oldValue) {
                  newValues[i] = value;
                  oldValues[i] = oldValue;
                  if (!changeReactionScheduled) {
                    changeReactionScheduled = true;
                    self.$evalAsync(watchGroupAction);
                  }
                });
                deregisterFns.push(unwatchFn);
              });
              function watchGroupAction() {
                changeReactionScheduled = false;
                if (firstRun) {
                  firstRun = false;
                  listener(newValues, newValues, self);
                } else {
                  listener(newValues, oldValues, self);
                }
              }
              return function deregisterWatchGroup() {
                while (deregisterFns.length) {
                  deregisterFns.shift()();
                }
              };
            },
            $watchCollection: function(obj, listener) {
              $watchCollectionInterceptor.$stateful = true;
              var self = this;
              var newValue;
              var oldValue;
              var veryOldValue;
              var trackVeryOldValue = (listener.length > 1);
              var changeDetected = 0;
              var changeDetector = $parse(obj, $watchCollectionInterceptor);
              var internalArray = [];
              var internalObject = {};
              var initRun = true;
              var oldLength = 0;
              function $watchCollectionInterceptor(_value) {
                newValue = _value;
                var newLength,
                    key,
                    bothNaN,
                    newItem,
                    oldItem;
                if (isUndefined(newValue))
                  return ;
                if (!isObject(newValue)) {
                  if (oldValue !== newValue) {
                    oldValue = newValue;
                    changeDetected++;
                  }
                } else if (isArrayLike(newValue)) {
                  if (oldValue !== internalArray) {
                    oldValue = internalArray;
                    oldLength = oldValue.length = 0;
                    changeDetected++;
                  }
                  newLength = newValue.length;
                  if (oldLength !== newLength) {
                    changeDetected++;
                    oldValue.length = oldLength = newLength;
                  }
                  for (var i = 0; i < newLength; i++) {
                    oldItem = oldValue[i];
                    newItem = newValue[i];
                    bothNaN = (oldItem !== oldItem) && (newItem !== newItem);
                    if (!bothNaN && (oldItem !== newItem)) {
                      changeDetected++;
                      oldValue[i] = newItem;
                    }
                  }
                } else {
                  if (oldValue !== internalObject) {
                    oldValue = internalObject = {};
                    oldLength = 0;
                    changeDetected++;
                  }
                  newLength = 0;
                  for (key in newValue) {
                    if (newValue.hasOwnProperty(key)) {
                      newLength++;
                      newItem = newValue[key];
                      oldItem = oldValue[key];
                      if (key in oldValue) {
                        bothNaN = (oldItem !== oldItem) && (newItem !== newItem);
                        if (!bothNaN && (oldItem !== newItem)) {
                          changeDetected++;
                          oldValue[key] = newItem;
                        }
                      } else {
                        oldLength++;
                        oldValue[key] = newItem;
                        changeDetected++;
                      }
                    }
                  }
                  if (oldLength > newLength) {
                    changeDetected++;
                    for (key in oldValue) {
                      if (!newValue.hasOwnProperty(key)) {
                        oldLength--;
                        delete oldValue[key];
                      }
                    }
                  }
                }
                return changeDetected;
              }
              function $watchCollectionAction() {
                if (initRun) {
                  initRun = false;
                  listener(newValue, newValue, self);
                } else {
                  listener(newValue, veryOldValue, self);
                }
                if (trackVeryOldValue) {
                  if (!isObject(newValue)) {
                    veryOldValue = newValue;
                  } else if (isArrayLike(newValue)) {
                    veryOldValue = new Array(newValue.length);
                    for (var i = 0; i < newValue.length; i++) {
                      veryOldValue[i] = newValue[i];
                    }
                  } else {
                    veryOldValue = {};
                    for (var key in newValue) {
                      if (hasOwnProperty.call(newValue, key)) {
                        veryOldValue[key] = newValue[key];
                      }
                    }
                  }
                }
              }
              return this.$watch(changeDetector, $watchCollectionAction);
            },
            $digest: function() {
              var watch,
                  value,
                  last,
                  watchers,
                  length,
                  dirty,
                  ttl = TTL,
                  next,
                  current,
                  target = this,
                  watchLog = [],
                  logIdx,
                  logMsg,
                  asyncTask;
              beginPhase('$digest');
              $browser.$$checkUrlChange();
              if (this === $rootScope && applyAsyncId !== null) {
                $browser.defer.cancel(applyAsyncId);
                flushApplyAsync();
              }
              lastDirtyWatch = null;
              do {
                dirty = false;
                current = target;
                while (asyncQueue.length) {
                  try {
                    asyncTask = asyncQueue.shift();
                    asyncTask.scope.$eval(asyncTask.expression, asyncTask.locals);
                  } catch (e) {
                    $exceptionHandler(e);
                  }
                  lastDirtyWatch = null;
                }
                traverseScopesLoop: do {
                  if ((watchers = current.$$watchers)) {
                    length = watchers.length;
                    while (length--) {
                      try {
                        watch = watchers[length];
                        if (watch) {
                          if ((value = watch.get(current)) !== (last = watch.last) && !(watch.eq ? equals(value, last) : (typeof value === 'number' && typeof last === 'number' && isNaN(value) && isNaN(last)))) {
                            dirty = true;
                            lastDirtyWatch = watch;
                            watch.last = watch.eq ? copy(value, null) : value;
                            watch.fn(value, ((last === initWatchVal) ? value : last), current);
                            if (ttl < 5) {
                              logIdx = 4 - ttl;
                              if (!watchLog[logIdx])
                                watchLog[logIdx] = [];
                              watchLog[logIdx].push({
                                msg: isFunction(watch.exp) ? 'fn: ' + (watch.exp.name || watch.exp.toString()) : watch.exp,
                                newVal: value,
                                oldVal: last
                              });
                            }
                          } else if (watch === lastDirtyWatch) {
                            dirty = false;
                            break traverseScopesLoop;
                          }
                        }
                      } catch (e) {
                        $exceptionHandler(e);
                      }
                    }
                  }
                  if (!(next = ((current.$$watchersCount && current.$$childHead) || (current !== target && current.$$nextSibling)))) {
                    while (current !== target && !(next = current.$$nextSibling)) {
                      current = current.$parent;
                    }
                  }
                } while ((current = next));
                if ((dirty || asyncQueue.length) && !(ttl--)) {
                  clearPhase();
                  throw $rootScopeMinErr('infdig', '{0} $digest() iterations reached. Aborting!\n' + 'Watchers fired in the last 5 iterations: {1}', TTL, watchLog);
                }
              } while (dirty || asyncQueue.length);
              clearPhase();
              while (postDigestQueue.length) {
                try {
                  postDigestQueue.shift()();
                } catch (e) {
                  $exceptionHandler(e);
                }
              }
            },
            $destroy: function() {
              if (this.$$destroyed)
                return ;
              var parent = this.$parent;
              this.$broadcast('$destroy');
              this.$$destroyed = true;
              if (this === $rootScope) {
                $browser.$$applicationDestroyed();
              }
              incrementWatchersCount(this, -this.$$watchersCount);
              for (var eventName in this.$$listenerCount) {
                decrementListenerCount(this, this.$$listenerCount[eventName], eventName);
              }
              if (parent && parent.$$childHead == this)
                parent.$$childHead = this.$$nextSibling;
              if (parent && parent.$$childTail == this)
                parent.$$childTail = this.$$prevSibling;
              if (this.$$prevSibling)
                this.$$prevSibling.$$nextSibling = this.$$nextSibling;
              if (this.$$nextSibling)
                this.$$nextSibling.$$prevSibling = this.$$prevSibling;
              this.$destroy = this.$digest = this.$apply = this.$evalAsync = this.$applyAsync = noop;
              this.$on = this.$watch = this.$watchGroup = function() {
                return noop;
              };
              this.$$listeners = {};
              this.$parent = this.$$nextSibling = this.$$prevSibling = this.$$childHead = this.$$childTail = this.$root = this.$$watchers = null;
            },
            $eval: function(expr, locals) {
              return $parse(expr)(this, locals);
            },
            $evalAsync: function(expr, locals) {
              if (!$rootScope.$$phase && !asyncQueue.length) {
                $browser.defer(function() {
                  if (asyncQueue.length) {
                    $rootScope.$digest();
                  }
                });
              }
              asyncQueue.push({
                scope: this,
                expression: expr,
                locals: locals
              });
            },
            $$postDigest: function(fn) {
              postDigestQueue.push(fn);
            },
            $apply: function(expr) {
              try {
                beginPhase('$apply');
                return this.$eval(expr);
              } catch (e) {
                $exceptionHandler(e);
              } finally {
                clearPhase();
                try {
                  $rootScope.$digest();
                } catch (e) {
                  $exceptionHandler(e);
                  throw e;
                }
              }
            },
            $applyAsync: function(expr) {
              var scope = this;
              expr && applyAsyncQueue.push($applyAsyncExpression);
              scheduleApplyAsync();
              function $applyAsyncExpression() {
                scope.$eval(expr);
              }
            },
            $on: function(name, listener) {
              var namedListeners = this.$$listeners[name];
              if (!namedListeners) {
                this.$$listeners[name] = namedListeners = [];
              }
              namedListeners.push(listener);
              var current = this;
              do {
                if (!current.$$listenerCount[name]) {
                  current.$$listenerCount[name] = 0;
                }
                current.$$listenerCount[name]++;
              } while ((current = current.$parent));
              var self = this;
              return function() {
                var indexOfListener = namedListeners.indexOf(listener);
                if (indexOfListener !== -1) {
                  namedListeners[indexOfListener] = null;
                  decrementListenerCount(self, 1, name);
                }
              };
            },
            $emit: function(name, args) {
              var empty = [],
                  namedListeners,
                  scope = this,
                  stopPropagation = false,
                  event = {
                    name: name,
                    targetScope: scope,
                    stopPropagation: function() {
                      stopPropagation = true;
                    },
                    preventDefault: function() {
                      event.defaultPrevented = true;
                    },
                    defaultPrevented: false
                  },
                  listenerArgs = concat([event], arguments, 1),
                  i,
                  length;
              do {
                namedListeners = scope.$$listeners[name] || empty;
                event.currentScope = scope;
                for (i = 0, length = namedListeners.length; i < length; i++) {
                  if (!namedListeners[i]) {
                    namedListeners.splice(i, 1);
                    i--;
                    length--;
                    continue;
                  }
                  try {
                    namedListeners[i].apply(null, listenerArgs);
                  } catch (e) {
                    $exceptionHandler(e);
                  }
                }
                if (stopPropagation) {
                  event.currentScope = null;
                  return event;
                }
                scope = scope.$parent;
              } while (scope);
              event.currentScope = null;
              return event;
            },
            $broadcast: function(name, args) {
              var target = this,
                  current = target,
                  next = target,
                  event = {
                    name: name,
                    targetScope: target,
                    preventDefault: function() {
                      event.defaultPrevented = true;
                    },
                    defaultPrevented: false
                  };
              if (!target.$$listenerCount[name])
                return event;
              var listenerArgs = concat([event], arguments, 1),
                  listeners,
                  i,
                  length;
              while ((current = next)) {
                event.currentScope = current;
                listeners = current.$$listeners[name] || [];
                for (i = 0, length = listeners.length; i < length; i++) {
                  if (!listeners[i]) {
                    listeners.splice(i, 1);
                    i--;
                    length--;
                    continue;
                  }
                  try {
                    listeners[i].apply(null, listenerArgs);
                  } catch (e) {
                    $exceptionHandler(e);
                  }
                }
                if (!(next = ((current.$$listenerCount[name] && current.$$childHead) || (current !== target && current.$$nextSibling)))) {
                  while (current !== target && !(next = current.$$nextSibling)) {
                    current = current.$parent;
                  }
                }
              }
              event.currentScope = null;
              return event;
            }
          };
          var $rootScope = new Scope();
          var asyncQueue = $rootScope.$$asyncQueue = [];
          var postDigestQueue = $rootScope.$$postDigestQueue = [];
          var applyAsyncQueue = $rootScope.$$applyAsyncQueue = [];
          return $rootScope;
          function beginPhase(phase) {
            if ($rootScope.$$phase) {
              throw $rootScopeMinErr('inprog', '{0} already in progress', $rootScope.$$phase);
            }
            $rootScope.$$phase = phase;
          }
          function clearPhase() {
            $rootScope.$$phase = null;
          }
          function incrementWatchersCount(current, count) {
            do {
              current.$$watchersCount += count;
            } while ((current = current.$parent));
          }
          function decrementListenerCount(current, count, name) {
            do {
              current.$$listenerCount[name] -= count;
              if (current.$$listenerCount[name] === 0) {
                delete current.$$listenerCount[name];
              }
            } while ((current = current.$parent));
          }
          function initWatchVal() {}
          function flushApplyAsync() {
            while (applyAsyncQueue.length) {
              try {
                applyAsyncQueue.shift()();
              } catch (e) {
                $exceptionHandler(e);
              }
            }
            applyAsyncId = null;
          }
          function scheduleApplyAsync() {
            if (applyAsyncId === null) {
              applyAsyncId = $browser.defer(function() {
                $rootScope.$apply(flushApplyAsync);
              });
            }
          }
        }];
      }
      function $$SanitizeUriProvider() {
        var aHrefSanitizationWhitelist = /^\s*(https?|ftp|mailto|tel|file):/,
            imgSrcSanitizationWhitelist = /^\s*((https?|ftp|file|blob):|data:image\/)/;
        this.aHrefSanitizationWhitelist = function(regexp) {
          if (isDefined(regexp)) {
            aHrefSanitizationWhitelist = regexp;
            return this;
          }
          return aHrefSanitizationWhitelist;
        };
        this.imgSrcSanitizationWhitelist = function(regexp) {
          if (isDefined(regexp)) {
            imgSrcSanitizationWhitelist = regexp;
            return this;
          }
          return imgSrcSanitizationWhitelist;
        };
        this.$get = function() {
          return function sanitizeUri(uri, isImage) {
            var regex = isImage ? imgSrcSanitizationWhitelist : aHrefSanitizationWhitelist;
            var normalizedVal;
            normalizedVal = urlResolve(uri).href;
            if (normalizedVal !== '' && !normalizedVal.match(regex)) {
              return 'unsafe:' + normalizedVal;
            }
            return uri;
          };
        };
      }
      var $sceMinErr = minErr('$sce');
      var SCE_CONTEXTS = {
        HTML: 'html',
        CSS: 'css',
        URL: 'url',
        RESOURCE_URL: 'resourceUrl',
        JS: 'js'
      };
      function adjustMatcher(matcher) {
        if (matcher === 'self') {
          return matcher;
        } else if (isString(matcher)) {
          if (matcher.indexOf('***') > -1) {
            throw $sceMinErr('iwcard', 'Illegal sequence *** in string matcher.  String: {0}', matcher);
          }
          matcher = escapeForRegexp(matcher).replace('\\*\\*', '.*').replace('\\*', '[^:/.?&;]*');
          return new RegExp('^' + matcher + '$');
        } else if (isRegExp(matcher)) {
          return new RegExp('^' + matcher.source + '$');
        } else {
          throw $sceMinErr('imatcher', 'Matchers may only be "self", string patterns or RegExp objects');
        }
      }
      function adjustMatchers(matchers) {
        var adjustedMatchers = [];
        if (isDefined(matchers)) {
          forEach(matchers, function(matcher) {
            adjustedMatchers.push(adjustMatcher(matcher));
          });
        }
        return adjustedMatchers;
      }
      function $SceDelegateProvider() {
        this.SCE_CONTEXTS = SCE_CONTEXTS;
        var resourceUrlWhitelist = ['self'],
            resourceUrlBlacklist = [];
        this.resourceUrlWhitelist = function(value) {
          if (arguments.length) {
            resourceUrlWhitelist = adjustMatchers(value);
          }
          return resourceUrlWhitelist;
        };
        this.resourceUrlBlacklist = function(value) {
          if (arguments.length) {
            resourceUrlBlacklist = adjustMatchers(value);
          }
          return resourceUrlBlacklist;
        };
        this.$get = ['$injector', function($injector) {
          var htmlSanitizer = function htmlSanitizer(html) {
            throw $sceMinErr('unsafe', 'Attempting to use an unsafe value in a safe context.');
          };
          if ($injector.has('$sanitize')) {
            htmlSanitizer = $injector.get('$sanitize');
          }
          function matchUrl(matcher, parsedUrl) {
            if (matcher === 'self') {
              return urlIsSameOrigin(parsedUrl);
            } else {
              return !!matcher.exec(parsedUrl.href);
            }
          }
          function isResourceUrlAllowedByPolicy(url) {
            var parsedUrl = urlResolve(url.toString());
            var i,
                n,
                allowed = false;
            for (i = 0, n = resourceUrlWhitelist.length; i < n; i++) {
              if (matchUrl(resourceUrlWhitelist[i], parsedUrl)) {
                allowed = true;
                break;
              }
            }
            if (allowed) {
              for (i = 0, n = resourceUrlBlacklist.length; i < n; i++) {
                if (matchUrl(resourceUrlBlacklist[i], parsedUrl)) {
                  allowed = false;
                  break;
                }
              }
            }
            return allowed;
          }
          function generateHolderType(Base) {
            var holderType = function TrustedValueHolderType(trustedValue) {
              this.$$unwrapTrustedValue = function() {
                return trustedValue;
              };
            };
            if (Base) {
              holderType.prototype = new Base();
            }
            holderType.prototype.valueOf = function sceValueOf() {
              return this.$$unwrapTrustedValue();
            };
            holderType.prototype.toString = function sceToString() {
              return this.$$unwrapTrustedValue().toString();
            };
            return holderType;
          }
          var trustedValueHolderBase = generateHolderType(),
              byType = {};
          byType[SCE_CONTEXTS.HTML] = generateHolderType(trustedValueHolderBase);
          byType[SCE_CONTEXTS.CSS] = generateHolderType(trustedValueHolderBase);
          byType[SCE_CONTEXTS.URL] = generateHolderType(trustedValueHolderBase);
          byType[SCE_CONTEXTS.JS] = generateHolderType(trustedValueHolderBase);
          byType[SCE_CONTEXTS.RESOURCE_URL] = generateHolderType(byType[SCE_CONTEXTS.URL]);
          function trustAs(type, trustedValue) {
            var Constructor = (byType.hasOwnProperty(type) ? byType[type] : null);
            if (!Constructor) {
              throw $sceMinErr('icontext', 'Attempted to trust a value in invalid context. Context: {0}; Value: {1}', type, trustedValue);
            }
            if (trustedValue === null || trustedValue === undefined || trustedValue === '') {
              return trustedValue;
            }
            if (typeof trustedValue !== 'string') {
              throw $sceMinErr('itype', 'Attempted to trust a non-string value in a content requiring a string: Context: {0}', type);
            }
            return new Constructor(trustedValue);
          }
          function valueOf(maybeTrusted) {
            if (maybeTrusted instanceof trustedValueHolderBase) {
              return maybeTrusted.$$unwrapTrustedValue();
            } else {
              return maybeTrusted;
            }
          }
          function getTrusted(type, maybeTrusted) {
            if (maybeTrusted === null || maybeTrusted === undefined || maybeTrusted === '') {
              return maybeTrusted;
            }
            var constructor = (byType.hasOwnProperty(type) ? byType[type] : null);
            if (constructor && maybeTrusted instanceof constructor) {
              return maybeTrusted.$$unwrapTrustedValue();
            }
            if (type === SCE_CONTEXTS.RESOURCE_URL) {
              if (isResourceUrlAllowedByPolicy(maybeTrusted)) {
                return maybeTrusted;
              } else {
                throw $sceMinErr('insecurl', 'Blocked loading resource from url not allowed by $sceDelegate policy.  URL: {0}', maybeTrusted.toString());
              }
            } else if (type === SCE_CONTEXTS.HTML) {
              return htmlSanitizer(maybeTrusted);
            }
            throw $sceMinErr('unsafe', 'Attempting to use an unsafe value in a safe context.');
          }
          return {
            trustAs: trustAs,
            getTrusted: getTrusted,
            valueOf: valueOf
          };
        }];
      }
      function $SceProvider() {
        var enabled = true;
        this.enabled = function(value) {
          if (arguments.length) {
            enabled = !!value;
          }
          return enabled;
        };
        this.$get = ['$parse', '$sceDelegate', function($parse, $sceDelegate) {
          if (enabled && msie < 8) {
            throw $sceMinErr('iequirks', 'Strict Contextual Escaping does not support Internet Explorer version < 11 in quirks ' + 'mode.  You can fix this by adding the text <!doctype html> to the top of your HTML ' + 'document.  See http://docs.angularjs.org/api/ng.$sce for more information.');
          }
          var sce = shallowCopy(SCE_CONTEXTS);
          sce.isEnabled = function() {
            return enabled;
          };
          sce.trustAs = $sceDelegate.trustAs;
          sce.getTrusted = $sceDelegate.getTrusted;
          sce.valueOf = $sceDelegate.valueOf;
          if (!enabled) {
            sce.trustAs = sce.getTrusted = function(type, value) {
              return value;
            };
            sce.valueOf = identity;
          }
          sce.parseAs = function sceParseAs(type, expr) {
            var parsed = $parse(expr);
            if (parsed.literal && parsed.constant) {
              return parsed;
            } else {
              return $parse(expr, function(value) {
                return sce.getTrusted(type, value);
              });
            }
          };
          var parse = sce.parseAs,
              getTrusted = sce.getTrusted,
              trustAs = sce.trustAs;
          forEach(SCE_CONTEXTS, function(enumValue, name) {
            var lName = lowercase(name);
            sce[camelCase("parse_as_" + lName)] = function(expr) {
              return parse(enumValue, expr);
            };
            sce[camelCase("get_trusted_" + lName)] = function(value) {
              return getTrusted(enumValue, value);
            };
            sce[camelCase("trust_as_" + lName)] = function(value) {
              return trustAs(enumValue, value);
            };
          });
          return sce;
        }];
      }
      function $SnifferProvider() {
        this.$get = ['$window', '$document', function($window, $document) {
          var eventSupport = {},
              android = toInt((/android (\d+)/.exec(lowercase(($window.navigator || {}).userAgent)) || [])[1]),
              boxee = /Boxee/i.test(($window.navigator || {}).userAgent),
              document = $document[0] || {},
              vendorPrefix,
              vendorRegex = /^(Moz|webkit|ms)(?=[A-Z])/,
              bodyStyle = document.body && document.body.style,
              transitions = false,
              animations = false,
              match;
          if (bodyStyle) {
            for (var prop in bodyStyle) {
              if (match = vendorRegex.exec(prop)) {
                vendorPrefix = match[0];
                vendorPrefix = vendorPrefix.substr(0, 1).toUpperCase() + vendorPrefix.substr(1);
                break;
              }
            }
            if (!vendorPrefix) {
              vendorPrefix = ('WebkitOpacity' in bodyStyle) && 'webkit';
            }
            transitions = !!(('transition' in bodyStyle) || (vendorPrefix + 'Transition' in bodyStyle));
            animations = !!(('animation' in bodyStyle) || (vendorPrefix + 'Animation' in bodyStyle));
            if (android && (!transitions || !animations)) {
              transitions = isString(bodyStyle.webkitTransition);
              animations = isString(bodyStyle.webkitAnimation);
            }
          }
          return {
            history: !!($window.history && $window.history.pushState && !(android < 4) && !boxee),
            hasEvent: function(event) {
              if (event === 'input' && msie <= 11)
                return false;
              if (isUndefined(eventSupport[event])) {
                var divElm = document.createElement('div');
                eventSupport[event] = 'on' + event in divElm;
              }
              return eventSupport[event];
            },
            csp: csp(),
            vendorPrefix: vendorPrefix,
            transitions: transitions,
            animations: animations,
            android: android
          };
        }];
      }
      var $compileMinErr = minErr('$compile');
      function $TemplateRequestProvider() {
        this.$get = ['$templateCache', '$http', '$q', function($templateCache, $http, $q) {
          function handleRequestFn(tpl, ignoreRequestError) {
            handleRequestFn.totalPendingRequests++;
            var transformResponse = $http.defaults && $http.defaults.transformResponse;
            if (isArray(transformResponse)) {
              transformResponse = transformResponse.filter(function(transformer) {
                return transformer !== defaultHttpResponseTransform;
              });
            } else if (transformResponse === defaultHttpResponseTransform) {
              transformResponse = null;
            }
            var httpOptions = {
              cache: $templateCache,
              transformResponse: transformResponse
            };
            return $http.get(tpl, httpOptions)['finally'](function() {
              handleRequestFn.totalPendingRequests--;
            }).then(function(response) {
              $templateCache.put(tpl, response.data);
              return response.data;
            }, handleError);
            function handleError(resp) {
              if (!ignoreRequestError) {
                throw $compileMinErr('tpload', 'Failed to load template: {0} (HTTP status: {1} {2})', tpl, resp.status, resp.statusText);
              }
              return $q.reject(resp);
            }
          }
          handleRequestFn.totalPendingRequests = 0;
          return handleRequestFn;
        }];
      }
      function $$TestabilityProvider() {
        this.$get = ['$rootScope', '$browser', '$location', function($rootScope, $browser, $location) {
          var testability = {};
          testability.findBindings = function(element, expression, opt_exactMatch) {
            var bindings = element.getElementsByClassName('ng-binding');
            var matches = [];
            forEach(bindings, function(binding) {
              var dataBinding = angular.element(binding).data('$binding');
              if (dataBinding) {
                forEach(dataBinding, function(bindingName) {
                  if (opt_exactMatch) {
                    var matcher = new RegExp('(^|\\s)' + escapeForRegexp(expression) + '(\\s|\\||$)');
                    if (matcher.test(bindingName)) {
                      matches.push(binding);
                    }
                  } else {
                    if (bindingName.indexOf(expression) != -1) {
                      matches.push(binding);
                    }
                  }
                });
              }
            });
            return matches;
          };
          testability.findModels = function(element, expression, opt_exactMatch) {
            var prefixes = ['ng-', 'data-ng-', 'ng\\:'];
            for (var p = 0; p < prefixes.length; ++p) {
              var attributeEquals = opt_exactMatch ? '=' : '*=';
              var selector = '[' + prefixes[p] + 'model' + attributeEquals + '"' + expression + '"]';
              var elements = element.querySelectorAll(selector);
              if (elements.length) {
                return elements;
              }
            }
          };
          testability.getLocation = function() {
            return $location.url();
          };
          testability.setLocation = function(url) {
            if (url !== $location.url()) {
              $location.url(url);
              $rootScope.$digest();
            }
          };
          testability.whenStable = function(callback) {
            $browser.notifyWhenNoOutstandingRequests(callback);
          };
          return testability;
        }];
      }
      function $TimeoutProvider() {
        this.$get = ['$rootScope', '$browser', '$q', '$$q', '$exceptionHandler', function($rootScope, $browser, $q, $$q, $exceptionHandler) {
          var deferreds = {};
          function timeout(fn, delay, invokeApply) {
            if (!isFunction(fn)) {
              invokeApply = delay;
              delay = fn;
              fn = noop;
            }
            var args = sliceArgs(arguments, 3),
                skipApply = (isDefined(invokeApply) && !invokeApply),
                deferred = (skipApply ? $$q : $q).defer(),
                promise = deferred.promise,
                timeoutId;
            timeoutId = $browser.defer(function() {
              try {
                deferred.resolve(fn.apply(null, args));
              } catch (e) {
                deferred.reject(e);
                $exceptionHandler(e);
              } finally {
                delete deferreds[promise.$$timeoutId];
              }
              if (!skipApply)
                $rootScope.$apply();
            }, delay);
            promise.$$timeoutId = timeoutId;
            deferreds[timeoutId] = deferred;
            return promise;
          }
          timeout.cancel = function(promise) {
            if (promise && promise.$$timeoutId in deferreds) {
              deferreds[promise.$$timeoutId].reject('canceled');
              delete deferreds[promise.$$timeoutId];
              return $browser.defer.cancel(promise.$$timeoutId);
            }
            return false;
          };
          return timeout;
        }];
      }
      var urlParsingNode = document.createElement("a");
      var originUrl = urlResolve(window.location.href);
      function urlResolve(url) {
        var href = url;
        if (msie) {
          urlParsingNode.setAttribute("href", href);
          href = urlParsingNode.href;
        }
        urlParsingNode.setAttribute('href', href);
        return {
          href: urlParsingNode.href,
          protocol: urlParsingNode.protocol ? urlParsingNode.protocol.replace(/:$/, '') : '',
          host: urlParsingNode.host,
          search: urlParsingNode.search ? urlParsingNode.search.replace(/^\?/, '') : '',
          hash: urlParsingNode.hash ? urlParsingNode.hash.replace(/^#/, '') : '',
          hostname: urlParsingNode.hostname,
          port: urlParsingNode.port,
          pathname: (urlParsingNode.pathname.charAt(0) === '/') ? urlParsingNode.pathname : '/' + urlParsingNode.pathname
        };
      }
      function urlIsSameOrigin(requestUrl) {
        var parsed = (isString(requestUrl)) ? urlResolve(requestUrl) : requestUrl;
        return (parsed.protocol === originUrl.protocol && parsed.host === originUrl.host);
      }
      function $WindowProvider() {
        this.$get = valueFn(window);
      }
      function $$CookieReader($document) {
        var rawDocument = $document[0] || {};
        var lastCookies = {};
        var lastCookieString = '';
        function safeDecodeURIComponent(str) {
          try {
            return decodeURIComponent(str);
          } catch (e) {
            return str;
          }
        }
        return function() {
          var cookieArray,
              cookie,
              i,
              index,
              name;
          var currentCookieString = rawDocument.cookie || '';
          if (currentCookieString !== lastCookieString) {
            lastCookieString = currentCookieString;
            cookieArray = lastCookieString.split('; ');
            lastCookies = {};
            for (i = 0; i < cookieArray.length; i++) {
              cookie = cookieArray[i];
              index = cookie.indexOf('=');
              if (index > 0) {
                name = safeDecodeURIComponent(cookie.substring(0, index));
                if (lastCookies[name] === undefined) {
                  lastCookies[name] = safeDecodeURIComponent(cookie.substring(index + 1));
                }
              }
            }
          }
          return lastCookies;
        };
      }
      $$CookieReader.$inject = ['$document'];
      function $$CookieReaderProvider() {
        this.$get = $$CookieReader;
      }
      $FilterProvider.$inject = ['$provide'];
      function $FilterProvider($provide) {
        var suffix = 'Filter';
        function register(name, factory) {
          if (isObject(name)) {
            var filters = {};
            forEach(name, function(filter, key) {
              filters[key] = register(key, filter);
            });
            return filters;
          } else {
            return $provide.factory(name + suffix, factory);
          }
        }
        this.register = register;
        this.$get = ['$injector', function($injector) {
          return function(name) {
            return $injector.get(name + suffix);
          };
        }];
        register('currency', currencyFilter);
        register('date', dateFilter);
        register('filter', filterFilter);
        register('json', jsonFilter);
        register('limitTo', limitToFilter);
        register('lowercase', lowercaseFilter);
        register('number', numberFilter);
        register('orderBy', orderByFilter);
        register('uppercase', uppercaseFilter);
      }
      function filterFilter() {
        return function(array, expression, comparator) {
          if (!isArrayLike(array)) {
            if (array == null) {
              return array;
            } else {
              throw minErr('filter')('notarray', 'Expected array but received: {0}', array);
            }
          }
          var expressionType = getTypeForFilter(expression);
          var predicateFn;
          var matchAgainstAnyProp;
          switch (expressionType) {
            case 'function':
              predicateFn = expression;
              break;
            case 'boolean':
            case 'null':
            case 'number':
            case 'string':
              matchAgainstAnyProp = true;
            case 'object':
              predicateFn = createPredicateFn(expression, comparator, matchAgainstAnyProp);
              break;
            default:
              return array;
          }
          return Array.prototype.filter.call(array, predicateFn);
        };
      }
      function hasCustomToString(obj) {
        return isFunction(obj.toString) && obj.toString !== Object.prototype.toString;
      }
      function createPredicateFn(expression, comparator, matchAgainstAnyProp) {
        var shouldMatchPrimitives = isObject(expression) && ('$' in expression);
        var predicateFn;
        if (comparator === true) {
          comparator = equals;
        } else if (!isFunction(comparator)) {
          comparator = function(actual, expected) {
            if (isUndefined(actual)) {
              return false;
            }
            if ((actual === null) || (expected === null)) {
              return actual === expected;
            }
            if (isObject(expected) || (isObject(actual) && !hasCustomToString(actual))) {
              return false;
            }
            actual = lowercase('' + actual);
            expected = lowercase('' + expected);
            return actual.indexOf(expected) !== -1;
          };
        }
        predicateFn = function(item) {
          if (shouldMatchPrimitives && !isObject(item)) {
            return deepCompare(item, expression.$, comparator, false);
          }
          return deepCompare(item, expression, comparator, matchAgainstAnyProp);
        };
        return predicateFn;
      }
      function deepCompare(actual, expected, comparator, matchAgainstAnyProp, dontMatchWholeObject) {
        var actualType = getTypeForFilter(actual);
        var expectedType = getTypeForFilter(expected);
        if ((expectedType === 'string') && (expected.charAt(0) === '!')) {
          return !deepCompare(actual, expected.substring(1), comparator, matchAgainstAnyProp);
        } else if (isArray(actual)) {
          return actual.some(function(item) {
            return deepCompare(item, expected, comparator, matchAgainstAnyProp);
          });
        }
        switch (actualType) {
          case 'object':
            var key;
            if (matchAgainstAnyProp) {
              for (key in actual) {
                if ((key.charAt(0) !== '$') && deepCompare(actual[key], expected, comparator, true)) {
                  return true;
                }
              }
              return dontMatchWholeObject ? false : deepCompare(actual, expected, comparator, false);
            } else if (expectedType === 'object') {
              for (key in expected) {
                var expectedVal = expected[key];
                if (isFunction(expectedVal) || isUndefined(expectedVal)) {
                  continue;
                }
                var matchAnyProperty = key === '$';
                var actualVal = matchAnyProperty ? actual : actual[key];
                if (!deepCompare(actualVal, expectedVal, comparator, matchAnyProperty, matchAnyProperty)) {
                  return false;
                }
              }
              return true;
            } else {
              return comparator(actual, expected);
            }
            break;
          case 'function':
            return false;
          default:
            return comparator(actual, expected);
        }
      }
      function getTypeForFilter(val) {
        return (val === null) ? 'null' : typeof val;
      }
      currencyFilter.$inject = ['$locale'];
      function currencyFilter($locale) {
        var formats = $locale.NUMBER_FORMATS;
        return function(amount, currencySymbol, fractionSize) {
          if (isUndefined(currencySymbol)) {
            currencySymbol = formats.CURRENCY_SYM;
          }
          if (isUndefined(fractionSize)) {
            fractionSize = formats.PATTERNS[1].maxFrac;
          }
          return (amount == null) ? amount : formatNumber(amount, formats.PATTERNS[1], formats.GROUP_SEP, formats.DECIMAL_SEP, fractionSize).replace(/\u00A4/g, currencySymbol);
        };
      }
      numberFilter.$inject = ['$locale'];
      function numberFilter($locale) {
        var formats = $locale.NUMBER_FORMATS;
        return function(number, fractionSize) {
          return (number == null) ? number : formatNumber(number, formats.PATTERNS[0], formats.GROUP_SEP, formats.DECIMAL_SEP, fractionSize);
        };
      }
      var DECIMAL_SEP = '.';
      function formatNumber(number, pattern, groupSep, decimalSep, fractionSize) {
        if (isObject(number))
          return '';
        var isNegative = number < 0;
        number = Math.abs(number);
        var isInfinity = number === Infinity;
        if (!isInfinity && !isFinite(number))
          return '';
        var numStr = number + '',
            formatedText = '',
            hasExponent = false,
            parts = [];
        if (isInfinity)
          formatedText = '\u221e';
        if (!isInfinity && numStr.indexOf('e') !== -1) {
          var match = numStr.match(/([\d\.]+)e(-?)(\d+)/);
          if (match && match[2] == '-' && match[3] > fractionSize + 1) {
            number = 0;
          } else {
            formatedText = numStr;
            hasExponent = true;
          }
        }
        if (!isInfinity && !hasExponent) {
          var fractionLen = (numStr.split(DECIMAL_SEP)[1] || '').length;
          if (isUndefined(fractionSize)) {
            fractionSize = Math.min(Math.max(pattern.minFrac, fractionLen), pattern.maxFrac);
          }
          number = +(Math.round(+(number.toString() + 'e' + fractionSize)).toString() + 'e' + -fractionSize);
          var fraction = ('' + number).split(DECIMAL_SEP);
          var whole = fraction[0];
          fraction = fraction[1] || '';
          var i,
              pos = 0,
              lgroup = pattern.lgSize,
              group = pattern.gSize;
          if (whole.length >= (lgroup + group)) {
            pos = whole.length - lgroup;
            for (i = 0; i < pos; i++) {
              if ((pos - i) % group === 0 && i !== 0) {
                formatedText += groupSep;
              }
              formatedText += whole.charAt(i);
            }
          }
          for (i = pos; i < whole.length; i++) {
            if ((whole.length - i) % lgroup === 0 && i !== 0) {
              formatedText += groupSep;
            }
            formatedText += whole.charAt(i);
          }
          while (fraction.length < fractionSize) {
            fraction += '0';
          }
          if (fractionSize && fractionSize !== "0")
            formatedText += decimalSep + fraction.substr(0, fractionSize);
        } else {
          if (fractionSize > 0 && number < 1) {
            formatedText = number.toFixed(fractionSize);
            number = parseFloat(formatedText);
          }
        }
        if (number === 0) {
          isNegative = false;
        }
        parts.push(isNegative ? pattern.negPre : pattern.posPre, formatedText, isNegative ? pattern.negSuf : pattern.posSuf);
        return parts.join('');
      }
      function padNumber(num, digits, trim) {
        var neg = '';
        if (num < 0) {
          neg = '-';
          num = -num;
        }
        num = '' + num;
        while (num.length < digits)
          num = '0' + num;
        if (trim) {
          num = num.substr(num.length - digits);
        }
        return neg + num;
      }
      function dateGetter(name, size, offset, trim) {
        offset = offset || 0;
        return function(date) {
          var value = date['get' + name]();
          if (offset > 0 || value > -offset) {
            value += offset;
          }
          if (value === 0 && offset == -12)
            value = 12;
          return padNumber(value, size, trim);
        };
      }
      function dateStrGetter(name, shortForm) {
        return function(date, formats) {
          var value = date['get' + name]();
          var get = uppercase(shortForm ? ('SHORT' + name) : name);
          return formats[get][value];
        };
      }
      function timeZoneGetter(date, formats, offset) {
        var zone = -1 * offset;
        var paddedZone = (zone >= 0) ? "+" : "";
        paddedZone += padNumber(Math[zone > 0 ? 'floor' : 'ceil'](zone / 60), 2) + padNumber(Math.abs(zone % 60), 2);
        return paddedZone;
      }
      function getFirstThursdayOfYear(year) {
        var dayOfWeekOnFirst = (new Date(year, 0, 1)).getDay();
        return new Date(year, 0, ((dayOfWeekOnFirst <= 4) ? 5 : 12) - dayOfWeekOnFirst);
      }
      function getThursdayThisWeek(datetime) {
        return new Date(datetime.getFullYear(), datetime.getMonth(), datetime.getDate() + (4 - datetime.getDay()));
      }
      function weekGetter(size) {
        return function(date) {
          var firstThurs = getFirstThursdayOfYear(date.getFullYear()),
              thisThurs = getThursdayThisWeek(date);
          var diff = +thisThurs - +firstThurs,
              result = 1 + Math.round(diff / 6.048e8);
          return padNumber(result, size);
        };
      }
      function ampmGetter(date, formats) {
        return date.getHours() < 12 ? formats.AMPMS[0] : formats.AMPMS[1];
      }
      function eraGetter(date, formats) {
        return date.getFullYear() <= 0 ? formats.ERAS[0] : formats.ERAS[1];
      }
      function longEraGetter(date, formats) {
        return date.getFullYear() <= 0 ? formats.ERANAMES[0] : formats.ERANAMES[1];
      }
      var DATE_FORMATS = {
        yyyy: dateGetter('FullYear', 4),
        yy: dateGetter('FullYear', 2, 0, true),
        y: dateGetter('FullYear', 1),
        MMMM: dateStrGetter('Month'),
        MMM: dateStrGetter('Month', true),
        MM: dateGetter('Month', 2, 1),
        M: dateGetter('Month', 1, 1),
        dd: dateGetter('Date', 2),
        d: dateGetter('Date', 1),
        HH: dateGetter('Hours', 2),
        H: dateGetter('Hours', 1),
        hh: dateGetter('Hours', 2, -12),
        h: dateGetter('Hours', 1, -12),
        mm: dateGetter('Minutes', 2),
        m: dateGetter('Minutes', 1),
        ss: dateGetter('Seconds', 2),
        s: dateGetter('Seconds', 1),
        sss: dateGetter('Milliseconds', 3),
        EEEE: dateStrGetter('Day'),
        EEE: dateStrGetter('Day', true),
        a: ampmGetter,
        Z: timeZoneGetter,
        ww: weekGetter(2),
        w: weekGetter(1),
        G: eraGetter,
        GG: eraGetter,
        GGG: eraGetter,
        GGGG: longEraGetter
      };
      var DATE_FORMATS_SPLIT = /((?:[^yMdHhmsaZEwG']+)|(?:'(?:[^']|'')*')|(?:E+|y+|M+|d+|H+|h+|m+|s+|a|Z|G+|w+))(.*)/,
          NUMBER_STRING = /^\-?\d+$/;
      dateFilter.$inject = ['$locale'];
      function dateFilter($locale) {
        var R_ISO8601_STR = /^(\d{4})-?(\d\d)-?(\d\d)(?:T(\d\d)(?::?(\d\d)(?::?(\d\d)(?:\.(\d+))?)?)?(Z|([+-])(\d\d):?(\d\d))?)?$/;
        function jsonStringToDate(string) {
          var match;
          if (match = string.match(R_ISO8601_STR)) {
            var date = new Date(0),
                tzHour = 0,
                tzMin = 0,
                dateSetter = match[8] ? date.setUTCFullYear : date.setFullYear,
                timeSetter = match[8] ? date.setUTCHours : date.setHours;
            if (match[9]) {
              tzHour = toInt(match[9] + match[10]);
              tzMin = toInt(match[9] + match[11]);
            }
            dateSetter.call(date, toInt(match[1]), toInt(match[2]) - 1, toInt(match[3]));
            var h = toInt(match[4] || 0) - tzHour;
            var m = toInt(match[5] || 0) - tzMin;
            var s = toInt(match[6] || 0);
            var ms = Math.round(parseFloat('0.' + (match[7] || 0)) * 1000);
            timeSetter.call(date, h, m, s, ms);
            return date;
          }
          return string;
        }
        return function(date, format, timezone) {
          var text = '',
              parts = [],
              fn,
              match;
          format = format || 'mediumDate';
          format = $locale.DATETIME_FORMATS[format] || format;
          if (isString(date)) {
            date = NUMBER_STRING.test(date) ? toInt(date) : jsonStringToDate(date);
          }
          if (isNumber(date)) {
            date = new Date(date);
          }
          if (!isDate(date) || !isFinite(date.getTime())) {
            return date;
          }
          while (format) {
            match = DATE_FORMATS_SPLIT.exec(format);
            if (match) {
              parts = concat(parts, match, 1);
              format = parts.pop();
            } else {
              parts.push(format);
              format = null;
            }
          }
          var dateTimezoneOffset = date.getTimezoneOffset();
          if (timezone) {
            dateTimezoneOffset = timezoneToOffset(timezone, date.getTimezoneOffset());
            date = convertTimezoneToLocal(date, timezone, true);
          }
          forEach(parts, function(value) {
            fn = DATE_FORMATS[value];
            text += fn ? fn(date, $locale.DATETIME_FORMATS, dateTimezoneOffset) : value.replace(/(^'|'$)/g, '').replace(/''/g, "'");
          });
          return text;
        };
      }
      function jsonFilter() {
        return function(object, spacing) {
          if (isUndefined(spacing)) {
            spacing = 2;
          }
          return toJson(object, spacing);
        };
      }
      var lowercaseFilter = valueFn(lowercase);
      var uppercaseFilter = valueFn(uppercase);
      function limitToFilter() {
        return function(input, limit, begin) {
          if (Math.abs(Number(limit)) === Infinity) {
            limit = Number(limit);
          } else {
            limit = toInt(limit);
          }
          if (isNaN(limit))
            return input;
          if (isNumber(input))
            input = input.toString();
          if (!isArray(input) && !isString(input))
            return input;
          begin = (!begin || isNaN(begin)) ? 0 : toInt(begin);
          begin = (begin < 0 && begin >= -input.length) ? input.length + begin : begin;
          if (limit >= 0) {
            return input.slice(begin, begin + limit);
          } else {
            if (begin === 0) {
              return input.slice(limit, input.length);
            } else {
              return input.slice(Math.max(0, begin + limit), begin);
            }
          }
        };
      }
      orderByFilter.$inject = ['$parse'];
      function orderByFilter($parse) {
        return function(array, sortPredicate, reverseOrder) {
          if (!(isArrayLike(array)))
            return array;
          sortPredicate = isArray(sortPredicate) ? sortPredicate : [sortPredicate];
          if (sortPredicate.length === 0) {
            sortPredicate = ['+'];
          }
          sortPredicate = sortPredicate.map(function(predicate) {
            var descending = false,
                get = predicate || identity;
            if (isString(predicate)) {
              if ((predicate.charAt(0) == '+' || predicate.charAt(0) == '-')) {
                descending = predicate.charAt(0) == '-';
                predicate = predicate.substring(1);
              }
              if (predicate === '') {
                return reverseComparator(compare, descending);
              }
              get = $parse(predicate);
              if (get.constant) {
                var key = get();
                return reverseComparator(function(a, b) {
                  return compare(a[key], b[key]);
                }, descending);
              }
            }
            return reverseComparator(function(a, b) {
              return compare(get(a), get(b));
            }, descending);
          });
          return slice.call(array).sort(reverseComparator(comparator, reverseOrder));
          function comparator(o1, o2) {
            for (var i = 0; i < sortPredicate.length; i++) {
              var comp = sortPredicate[i](o1, o2);
              if (comp !== 0)
                return comp;
            }
            return 0;
          }
          function reverseComparator(comp, descending) {
            return descending ? function(a, b) {
              return comp(b, a);
            } : comp;
          }
          function isPrimitive(value) {
            switch (typeof value) {
              case 'number':
              case 'boolean':
              case 'string':
                return true;
              default:
                return false;
            }
          }
          function objectToString(value) {
            if (value === null)
              return 'null';
            if (typeof value.valueOf === 'function') {
              value = value.valueOf();
              if (isPrimitive(value))
                return value;
            }
            if (typeof value.toString === 'function') {
              value = value.toString();
              if (isPrimitive(value))
                return value;
            }
            return '';
          }
          function compare(v1, v2) {
            var t1 = typeof v1;
            var t2 = typeof v2;
            if (t1 === t2 && t1 === "object") {
              v1 = objectToString(v1);
              v2 = objectToString(v2);
            }
            if (t1 === t2) {
              if (t1 === "string") {
                v1 = v1.toLowerCase();
                v2 = v2.toLowerCase();
              }
              if (v1 === v2)
                return 0;
              return v1 < v2 ? -1 : 1;
            } else {
              return t1 < t2 ? -1 : 1;
            }
          }
        };
      }
      function ngDirective(directive) {
        if (isFunction(directive)) {
          directive = {link: directive};
        }
        directive.restrict = directive.restrict || 'AC';
        return valueFn(directive);
      }
      var htmlAnchorDirective = valueFn({
        restrict: 'E',
        compile: function(element, attr) {
          if (!attr.href && !attr.xlinkHref) {
            return function(scope, element) {
              if (element[0].nodeName.toLowerCase() !== 'a')
                return ;
              var href = toString.call(element.prop('href')) === '[object SVGAnimatedString]' ? 'xlink:href' : 'href';
              element.on('click', function(event) {
                if (!element.attr(href)) {
                  event.preventDefault();
                }
              });
            };
          }
        }
      });
      var ngAttributeAliasDirectives = {};
      forEach(BOOLEAN_ATTR, function(propName, attrName) {
        if (propName == "multiple")
          return ;
        function defaultLinkFn(scope, element, attr) {
          scope.$watch(attr[normalized], function ngBooleanAttrWatchAction(value) {
            attr.$set(attrName, !!value);
          });
        }
        var normalized = directiveNormalize('ng-' + attrName);
        var linkFn = defaultLinkFn;
        if (propName === 'checked') {
          linkFn = function(scope, element, attr) {
            if (attr.ngModel !== attr[normalized]) {
              defaultLinkFn(scope, element, attr);
            }
          };
        }
        ngAttributeAliasDirectives[normalized] = function() {
          return {
            restrict: 'A',
            priority: 100,
            link: linkFn
          };
        };
      });
      forEach(ALIASED_ATTR, function(htmlAttr, ngAttr) {
        ngAttributeAliasDirectives[ngAttr] = function() {
          return {
            priority: 100,
            link: function(scope, element, attr) {
              if (ngAttr === "ngPattern" && attr.ngPattern.charAt(0) == "/") {
                var match = attr.ngPattern.match(REGEX_STRING_REGEXP);
                if (match) {
                  attr.$set("ngPattern", new RegExp(match[1], match[2]));
                  return ;
                }
              }
              scope.$watch(attr[ngAttr], function ngAttrAliasWatchAction(value) {
                attr.$set(ngAttr, value);
              });
            }
          };
        };
      });
      forEach(['src', 'srcset', 'href'], function(attrName) {
        var normalized = directiveNormalize('ng-' + attrName);
        ngAttributeAliasDirectives[normalized] = function() {
          return {
            priority: 99,
            link: function(scope, element, attr) {
              var propName = attrName,
                  name = attrName;
              if (attrName === 'href' && toString.call(element.prop('href')) === '[object SVGAnimatedString]') {
                name = 'xlinkHref';
                attr.$attr[name] = 'xlink:href';
                propName = null;
              }
              attr.$observe(normalized, function(value) {
                if (!value) {
                  if (attrName === 'href') {
                    attr.$set(name, null);
                  }
                  return ;
                }
                attr.$set(name, value);
                if (msie && propName)
                  element.prop(propName, attr[name]);
              });
            }
          };
        };
      });
      var nullFormCtrl = {
        $addControl: noop,
        $$renameControl: nullFormRenameControl,
        $removeControl: noop,
        $setValidity: noop,
        $setDirty: noop,
        $setPristine: noop,
        $setSubmitted: noop
      },
          SUBMITTED_CLASS = 'ng-submitted';
      function nullFormRenameControl(control, name) {
        control.$name = name;
      }
      FormController.$inject = ['$element', '$attrs', '$scope', '$animate', '$interpolate'];
      function FormController(element, attrs, $scope, $animate, $interpolate) {
        var form = this,
            controls = [];
        var parentForm = form.$$parentForm = element.parent().controller('form') || nullFormCtrl;
        form.$error = {};
        form.$$success = {};
        form.$pending = undefined;
        form.$name = $interpolate(attrs.name || attrs.ngForm || '')($scope);
        form.$dirty = false;
        form.$pristine = true;
        form.$valid = true;
        form.$invalid = false;
        form.$submitted = false;
        parentForm.$addControl(form);
        form.$rollbackViewValue = function() {
          forEach(controls, function(control) {
            control.$rollbackViewValue();
          });
        };
        form.$commitViewValue = function() {
          forEach(controls, function(control) {
            control.$commitViewValue();
          });
        };
        form.$addControl = function(control) {
          assertNotHasOwnProperty(control.$name, 'input');
          controls.push(control);
          if (control.$name) {
            form[control.$name] = control;
          }
        };
        form.$$renameControl = function(control, newName) {
          var oldName = control.$name;
          if (form[oldName] === control) {
            delete form[oldName];
          }
          form[newName] = control;
          control.$name = newName;
        };
        form.$removeControl = function(control) {
          if (control.$name && form[control.$name] === control) {
            delete form[control.$name];
          }
          forEach(form.$pending, function(value, name) {
            form.$setValidity(name, null, control);
          });
          forEach(form.$error, function(value, name) {
            form.$setValidity(name, null, control);
          });
          forEach(form.$$success, function(value, name) {
            form.$setValidity(name, null, control);
          });
          arrayRemove(controls, control);
        };
        addSetValidityMethod({
          ctrl: this,
          $element: element,
          set: function(object, property, controller) {
            var list = object[property];
            if (!list) {
              object[property] = [controller];
            } else {
              var index = list.indexOf(controller);
              if (index === -1) {
                list.push(controller);
              }
            }
          },
          unset: function(object, property, controller) {
            var list = object[property];
            if (!list) {
              return ;
            }
            arrayRemove(list, controller);
            if (list.length === 0) {
              delete object[property];
            }
          },
          parentForm: parentForm,
          $animate: $animate
        });
        form.$setDirty = function() {
          $animate.removeClass(element, PRISTINE_CLASS);
          $animate.addClass(element, DIRTY_CLASS);
          form.$dirty = true;
          form.$pristine = false;
          parentForm.$setDirty();
        };
        form.$setPristine = function() {
          $animate.setClass(element, PRISTINE_CLASS, DIRTY_CLASS + ' ' + SUBMITTED_CLASS);
          form.$dirty = false;
          form.$pristine = true;
          form.$submitted = false;
          forEach(controls, function(control) {
            control.$setPristine();
          });
        };
        form.$setUntouched = function() {
          forEach(controls, function(control) {
            control.$setUntouched();
          });
        };
        form.$setSubmitted = function() {
          $animate.addClass(element, SUBMITTED_CLASS);
          form.$submitted = true;
          parentForm.$setSubmitted();
        };
      }
      var formDirectiveFactory = function(isNgForm) {
        return ['$timeout', function($timeout) {
          var formDirective = {
            name: 'form',
            restrict: isNgForm ? 'EAC' : 'E',
            controller: FormController,
            compile: function ngFormCompile(formElement, attr) {
              formElement.addClass(PRISTINE_CLASS).addClass(VALID_CLASS);
              var nameAttr = attr.name ? 'name' : (isNgForm && attr.ngForm ? 'ngForm' : false);
              return {pre: function ngFormPreLink(scope, formElement, attr, controller) {
                  if (!('action' in attr)) {
                    var handleFormSubmission = function(event) {
                      scope.$apply(function() {
                        controller.$commitViewValue();
                        controller.$setSubmitted();
                      });
                      event.preventDefault();
                    };
                    addEventListenerFn(formElement[0], 'submit', handleFormSubmission);
                    formElement.on('$destroy', function() {
                      $timeout(function() {
                        removeEventListenerFn(formElement[0], 'submit', handleFormSubmission);
                      }, 0, false);
                    });
                  }
                  var parentFormCtrl = controller.$$parentForm;
                  if (nameAttr) {
                    setter(scope, controller.$name, controller, controller.$name);
                    attr.$observe(nameAttr, function(newValue) {
                      if (controller.$name === newValue)
                        return ;
                      setter(scope, controller.$name, undefined, controller.$name);
                      parentFormCtrl.$$renameControl(controller, newValue);
                      setter(scope, controller.$name, controller, controller.$name);
                    });
                  }
                  formElement.on('$destroy', function() {
                    parentFormCtrl.$removeControl(controller);
                    if (nameAttr) {
                      setter(scope, attr[nameAttr], undefined, controller.$name);
                    }
                    extend(controller, nullFormCtrl);
                  });
                }};
            }
          };
          return formDirective;
        }];
      };
      var formDirective = formDirectiveFactory();
      var ngFormDirective = formDirectiveFactory(true);
      var ISO_DATE_REGEXP = /\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d\.\d+([+-][0-2]\d:[0-5]\d|Z)/;
      var URL_REGEXP = /^(ftp|http|https):\/\/(\w+:{0,1}\w*@)?(\S+)(:[0-9]+)?(\/|\/([\w#!:.?+=&%@!\-\/]))?$/;
      var EMAIL_REGEXP = /^[a-z0-9!#$%&'*+\/=?^_`{|}~.-]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;
      var NUMBER_REGEXP = /^\s*(\-|\+)?(\d+|(\d*(\.\d*)))([eE][+-]?\d+)?\s*$/;
      var DATE_REGEXP = /^(\d{4})-(\d{2})-(\d{2})$/;
      var DATETIMELOCAL_REGEXP = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d)(\.\d{1,3})?)?$/;
      var WEEK_REGEXP = /^(\d{4})-W(\d\d)$/;
      var MONTH_REGEXP = /^(\d{4})-(\d\d)$/;
      var TIME_REGEXP = /^(\d\d):(\d\d)(?::(\d\d)(\.\d{1,3})?)?$/;
      var inputType = {
        'text': textInputType,
        'date': createDateInputType('date', DATE_REGEXP, createDateParser(DATE_REGEXP, ['yyyy', 'MM', 'dd']), 'yyyy-MM-dd'),
        'datetime-local': createDateInputType('datetimelocal', DATETIMELOCAL_REGEXP, createDateParser(DATETIMELOCAL_REGEXP, ['yyyy', 'MM', 'dd', 'HH', 'mm', 'ss', 'sss']), 'yyyy-MM-ddTHH:mm:ss.sss'),
        'time': createDateInputType('time', TIME_REGEXP, createDateParser(TIME_REGEXP, ['HH', 'mm', 'ss', 'sss']), 'HH:mm:ss.sss'),
        'week': createDateInputType('week', WEEK_REGEXP, weekParser, 'yyyy-Www'),
        'month': createDateInputType('month', MONTH_REGEXP, createDateParser(MONTH_REGEXP, ['yyyy', 'MM']), 'yyyy-MM'),
        'number': numberInputType,
        'url': urlInputType,
        'email': emailInputType,
        'radio': radioInputType,
        'checkbox': checkboxInputType,
        'hidden': noop,
        'button': noop,
        'submit': noop,
        'reset': noop,
        'file': noop
      };
      function stringBasedInputType(ctrl) {
        ctrl.$formatters.push(function(value) {
          return ctrl.$isEmpty(value) ? value : value.toString();
        });
      }
      function textInputType(scope, element, attr, ctrl, $sniffer, $browser) {
        baseInputType(scope, element, attr, ctrl, $sniffer, $browser);
        stringBasedInputType(ctrl);
      }
      function baseInputType(scope, element, attr, ctrl, $sniffer, $browser) {
        var type = lowercase(element[0].type);
        if (!$sniffer.android) {
          var composing = false;
          element.on('compositionstart', function(data) {
            composing = true;
          });
          element.on('compositionend', function() {
            composing = false;
            listener();
          });
        }
        var listener = function(ev) {
          if (timeout) {
            $browser.defer.cancel(timeout);
            timeout = null;
          }
          if (composing)
            return ;
          var value = element.val(),
              event = ev && ev.type;
          if (type !== 'password' && (!attr.ngTrim || attr.ngTrim !== 'false')) {
            value = trim(value);
          }
          if (ctrl.$viewValue !== value || (value === '' && ctrl.$$hasNativeValidators)) {
            ctrl.$setViewValue(value, event);
          }
        };
        if ($sniffer.hasEvent('input')) {
          element.on('input', listener);
        } else {
          var timeout;
          var deferListener = function(ev, input, origValue) {
            if (!timeout) {
              timeout = $browser.defer(function() {
                timeout = null;
                if (!input || input.value !== origValue) {
                  listener(ev);
                }
              });
            }
          };
          element.on('keydown', function(event) {
            var key = event.keyCode;
            if (key === 91 || (15 < key && key < 19) || (37 <= key && key <= 40))
              return ;
            deferListener(event, this, this.value);
          });
          if ($sniffer.hasEvent('paste')) {
            element.on('paste cut', deferListener);
          }
        }
        element.on('change', listener);
        ctrl.$render = function() {
          element.val(ctrl.$isEmpty(ctrl.$viewValue) ? '' : ctrl.$viewValue);
        };
      }
      function weekParser(isoWeek, existingDate) {
        if (isDate(isoWeek)) {
          return isoWeek;
        }
        if (isString(isoWeek)) {
          WEEK_REGEXP.lastIndex = 0;
          var parts = WEEK_REGEXP.exec(isoWeek);
          if (parts) {
            var year = +parts[1],
                week = +parts[2],
                hours = 0,
                minutes = 0,
                seconds = 0,
                milliseconds = 0,
                firstThurs = getFirstThursdayOfYear(year),
                addDays = (week - 1) * 7;
            if (existingDate) {
              hours = existingDate.getHours();
              minutes = existingDate.getMinutes();
              seconds = existingDate.getSeconds();
              milliseconds = existingDate.getMilliseconds();
            }
            return new Date(year, 0, firstThurs.getDate() + addDays, hours, minutes, seconds, milliseconds);
          }
        }
        return NaN;
      }
      function createDateParser(regexp, mapping) {
        return function(iso, date) {
          var parts,
              map;
          if (isDate(iso)) {
            return iso;
          }
          if (isString(iso)) {
            if (iso.charAt(0) == '"' && iso.charAt(iso.length - 1) == '"') {
              iso = iso.substring(1, iso.length - 1);
            }
            if (ISO_DATE_REGEXP.test(iso)) {
              return new Date(iso);
            }
            regexp.lastIndex = 0;
            parts = regexp.exec(iso);
            if (parts) {
              parts.shift();
              if (date) {
                map = {
                  yyyy: date.getFullYear(),
                  MM: date.getMonth() + 1,
                  dd: date.getDate(),
                  HH: date.getHours(),
                  mm: date.getMinutes(),
                  ss: date.getSeconds(),
                  sss: date.getMilliseconds() / 1000
                };
              } else {
                map = {
                  yyyy: 1970,
                  MM: 1,
                  dd: 1,
                  HH: 0,
                  mm: 0,
                  ss: 0,
                  sss: 0
                };
              }
              forEach(parts, function(part, index) {
                if (index < mapping.length) {
                  map[mapping[index]] = +part;
                }
              });
              return new Date(map.yyyy, map.MM - 1, map.dd, map.HH, map.mm, map.ss || 0, map.sss * 1000 || 0);
            }
          }
          return NaN;
        };
      }
      function createDateInputType(type, regexp, parseDate, format) {
        return function dynamicDateInputType(scope, element, attr, ctrl, $sniffer, $browser, $filter) {
          badInputChecker(scope, element, attr, ctrl);
          baseInputType(scope, element, attr, ctrl, $sniffer, $browser);
          var timezone = ctrl && ctrl.$options && ctrl.$options.timezone;
          var previousDate;
          ctrl.$$parserName = type;
          ctrl.$parsers.push(function(value) {
            if (ctrl.$isEmpty(value))
              return null;
            if (regexp.test(value)) {
              var parsedDate = parseDate(value, previousDate);
              if (timezone) {
                parsedDate = convertTimezoneToLocal(parsedDate, timezone);
              }
              return parsedDate;
            }
            return undefined;
          });
          ctrl.$formatters.push(function(value) {
            if (value && !isDate(value)) {
              throw $ngModelMinErr('datefmt', 'Expected `{0}` to be a date', value);
            }
            if (isValidDate(value)) {
              previousDate = value;
              if (previousDate && timezone) {
                previousDate = convertTimezoneToLocal(previousDate, timezone, true);
              }
              return $filter('date')(value, format, timezone);
            } else {
              previousDate = null;
              return '';
            }
          });
          if (isDefined(attr.min) || attr.ngMin) {
            var minVal;
            ctrl.$validators.min = function(value) {
              return !isValidDate(value) || isUndefined(minVal) || parseDate(value) >= minVal;
            };
            attr.$observe('min', function(val) {
              minVal = parseObservedDateValue(val);
              ctrl.$validate();
            });
          }
          if (isDefined(attr.max) || attr.ngMax) {
            var maxVal;
            ctrl.$validators.max = function(value) {
              return !isValidDate(value) || isUndefined(maxVal) || parseDate(value) <= maxVal;
            };
            attr.$observe('max', function(val) {
              maxVal = parseObservedDateValue(val);
              ctrl.$validate();
            });
          }
          function isValidDate(value) {
            return value && !(value.getTime && value.getTime() !== value.getTime());
          }
          function parseObservedDateValue(val) {
            return isDefined(val) ? (isDate(val) ? val : parseDate(val)) : undefined;
          }
        };
      }
      function badInputChecker(scope, element, attr, ctrl) {
        var node = element[0];
        var nativeValidation = ctrl.$$hasNativeValidators = isObject(node.validity);
        if (nativeValidation) {
          ctrl.$parsers.push(function(value) {
            var validity = element.prop(VALIDITY_STATE_PROPERTY) || {};
            return validity.badInput && !validity.typeMismatch ? undefined : value;
          });
        }
      }
      function numberInputType(scope, element, attr, ctrl, $sniffer, $browser) {
        badInputChecker(scope, element, attr, ctrl);
        baseInputType(scope, element, attr, ctrl, $sniffer, $browser);
        ctrl.$$parserName = 'number';
        ctrl.$parsers.push(function(value) {
          if (ctrl.$isEmpty(value))
            return null;
          if (NUMBER_REGEXP.test(value))
            return parseFloat(value);
          return undefined;
        });
        ctrl.$formatters.push(function(value) {
          if (!ctrl.$isEmpty(value)) {
            if (!isNumber(value)) {
              throw $ngModelMinErr('numfmt', 'Expected `{0}` to be a number', value);
            }
            value = value.toString();
          }
          return value;
        });
        if (isDefined(attr.min) || attr.ngMin) {
          var minVal;
          ctrl.$validators.min = function(value) {
            return ctrl.$isEmpty(value) || isUndefined(minVal) || value >= minVal;
          };
          attr.$observe('min', function(val) {
            if (isDefined(val) && !isNumber(val)) {
              val = parseFloat(val, 10);
            }
            minVal = isNumber(val) && !isNaN(val) ? val : undefined;
            ctrl.$validate();
          });
        }
        if (isDefined(attr.max) || attr.ngMax) {
          var maxVal;
          ctrl.$validators.max = function(value) {
            return ctrl.$isEmpty(value) || isUndefined(maxVal) || value <= maxVal;
          };
          attr.$observe('max', function(val) {
            if (isDefined(val) && !isNumber(val)) {
              val = parseFloat(val, 10);
            }
            maxVal = isNumber(val) && !isNaN(val) ? val : undefined;
            ctrl.$validate();
          });
        }
      }
      function urlInputType(scope, element, attr, ctrl, $sniffer, $browser) {
        baseInputType(scope, element, attr, ctrl, $sniffer, $browser);
        stringBasedInputType(ctrl);
        ctrl.$$parserName = 'url';
        ctrl.$validators.url = function(modelValue, viewValue) {
          var value = modelValue || viewValue;
          return ctrl.$isEmpty(value) || URL_REGEXP.test(value);
        };
      }
      function emailInputType(scope, element, attr, ctrl, $sniffer, $browser) {
        baseInputType(scope, element, attr, ctrl, $sniffer, $browser);
        stringBasedInputType(ctrl);
        ctrl.$$parserName = 'email';
        ctrl.$validators.email = function(modelValue, viewValue) {
          var value = modelValue || viewValue;
          return ctrl.$isEmpty(value) || EMAIL_REGEXP.test(value);
        };
      }
      function radioInputType(scope, element, attr, ctrl) {
        if (isUndefined(attr.name)) {
          element.attr('name', nextUid());
        }
        var listener = function(ev) {
          if (element[0].checked) {
            ctrl.$setViewValue(attr.value, ev && ev.type);
          }
        };
        element.on('click', listener);
        ctrl.$render = function() {
          var value = attr.value;
          element[0].checked = (value == ctrl.$viewValue);
        };
        attr.$observe('value', ctrl.$render);
      }
      function parseConstantExpr($parse, context, name, expression, fallback) {
        var parseFn;
        if (isDefined(expression)) {
          parseFn = $parse(expression);
          if (!parseFn.constant) {
            throw minErr('ngModel')('constexpr', 'Expected constant expression for `{0}`, but saw ' + '`{1}`.', name, expression);
          }
          return parseFn(context);
        }
        return fallback;
      }
      function checkboxInputType(scope, element, attr, ctrl, $sniffer, $browser, $filter, $parse) {
        var trueValue = parseConstantExpr($parse, scope, 'ngTrueValue', attr.ngTrueValue, true);
        var falseValue = parseConstantExpr($parse, scope, 'ngFalseValue', attr.ngFalseValue, false);
        var listener = function(ev) {
          ctrl.$setViewValue(element[0].checked, ev && ev.type);
        };
        element.on('click', listener);
        ctrl.$render = function() {
          element[0].checked = ctrl.$viewValue;
        };
        ctrl.$isEmpty = function(value) {
          return value === false;
        };
        ctrl.$formatters.push(function(value) {
          return equals(value, trueValue);
        });
        ctrl.$parsers.push(function(value) {
          return value ? trueValue : falseValue;
        });
      }
      var inputDirective = ['$browser', '$sniffer', '$filter', '$parse', function($browser, $sniffer, $filter, $parse) {
        return {
          restrict: 'E',
          require: ['?ngModel'],
          link: {pre: function(scope, element, attr, ctrls) {
              if (ctrls[0]) {
                (inputType[lowercase(attr.type)] || inputType.text)(scope, element, attr, ctrls[0], $sniffer, $browser, $filter, $parse);
              }
            }}
        };
      }];
      var CONSTANT_VALUE_REGEXP = /^(true|false|\d+)$/;
      var ngValueDirective = function() {
        return {
          restrict: 'A',
          priority: 100,
          compile: function(tpl, tplAttr) {
            if (CONSTANT_VALUE_REGEXP.test(tplAttr.ngValue)) {
              return function ngValueConstantLink(scope, elm, attr) {
                attr.$set('value', scope.$eval(attr.ngValue));
              };
            } else {
              return function ngValueLink(scope, elm, attr) {
                scope.$watch(attr.ngValue, function valueWatchAction(value) {
                  attr.$set('value', value);
                });
              };
            }
          }
        };
      };
      var ngBindDirective = ['$compile', function($compile) {
        return {
          restrict: 'AC',
          compile: function ngBindCompile(templateElement) {
            $compile.$$addBindingClass(templateElement);
            return function ngBindLink(scope, element, attr) {
              $compile.$$addBindingInfo(element, attr.ngBind);
              element = element[0];
              scope.$watch(attr.ngBind, function ngBindWatchAction(value) {
                element.textContent = value === undefined ? '' : value;
              });
            };
          }
        };
      }];
      var ngBindTemplateDirective = ['$interpolate', '$compile', function($interpolate, $compile) {
        return {compile: function ngBindTemplateCompile(templateElement) {
            $compile.$$addBindingClass(templateElement);
            return function ngBindTemplateLink(scope, element, attr) {
              var interpolateFn = $interpolate(element.attr(attr.$attr.ngBindTemplate));
              $compile.$$addBindingInfo(element, interpolateFn.expressions);
              element = element[0];
              attr.$observe('ngBindTemplate', function(value) {
                element.textContent = value === undefined ? '' : value;
              });
            };
          }};
      }];
      var ngBindHtmlDirective = ['$sce', '$parse', '$compile', function($sce, $parse, $compile) {
        return {
          restrict: 'A',
          compile: function ngBindHtmlCompile(tElement, tAttrs) {
            var ngBindHtmlGetter = $parse(tAttrs.ngBindHtml);
            var ngBindHtmlWatch = $parse(tAttrs.ngBindHtml, function getStringValue(value) {
              return (value || '').toString();
            });
            $compile.$$addBindingClass(tElement);
            return function ngBindHtmlLink(scope, element, attr) {
              $compile.$$addBindingInfo(element, attr.ngBindHtml);
              scope.$watch(ngBindHtmlWatch, function ngBindHtmlWatchAction() {
                element.html($sce.getTrustedHtml(ngBindHtmlGetter(scope)) || '');
              });
            };
          }
        };
      }];
      var ngChangeDirective = valueFn({
        restrict: 'A',
        require: 'ngModel',
        link: function(scope, element, attr, ctrl) {
          ctrl.$viewChangeListeners.push(function() {
            scope.$eval(attr.ngChange);
          });
        }
      });
      function classDirective(name, selector) {
        name = 'ngClass' + name;
        return ['$animate', function($animate) {
          return {
            restrict: 'AC',
            link: function(scope, element, attr) {
              var oldVal;
              scope.$watch(attr[name], ngClassWatchAction, true);
              attr.$observe('class', function(value) {
                ngClassWatchAction(scope.$eval(attr[name]));
              });
              if (name !== 'ngClass') {
                scope.$watch('$index', function($index, old$index) {
                  var mod = $index & 1;
                  if (mod !== (old$index & 1)) {
                    var classes = arrayClasses(scope.$eval(attr[name]));
                    mod === selector ? addClasses(classes) : removeClasses(classes);
                  }
                });
              }
              function addClasses(classes) {
                var newClasses = digestClassCounts(classes, 1);
                attr.$addClass(newClasses);
              }
              function removeClasses(classes) {
                var newClasses = digestClassCounts(classes, -1);
                attr.$removeClass(newClasses);
              }
              function digestClassCounts(classes, count) {
                var classCounts = element.data('$classCounts') || createMap();
                var classesToUpdate = [];
                forEach(classes, function(className) {
                  if (count > 0 || classCounts[className]) {
                    classCounts[className] = (classCounts[className] || 0) + count;
                    if (classCounts[className] === +(count > 0)) {
                      classesToUpdate.push(className);
                    }
                  }
                });
                element.data('$classCounts', classCounts);
                return classesToUpdate.join(' ');
              }
              function updateClasses(oldClasses, newClasses) {
                var toAdd = arrayDifference(newClasses, oldClasses);
                var toRemove = arrayDifference(oldClasses, newClasses);
                toAdd = digestClassCounts(toAdd, 1);
                toRemove = digestClassCounts(toRemove, -1);
                if (toAdd && toAdd.length) {
                  $animate.addClass(element, toAdd);
                }
                if (toRemove && toRemove.length) {
                  $animate.removeClass(element, toRemove);
                }
              }
              function ngClassWatchAction(newVal) {
                if (selector === true || scope.$index % 2 === selector) {
                  var newClasses = arrayClasses(newVal || []);
                  if (!oldVal) {
                    addClasses(newClasses);
                  } else if (!equals(newVal, oldVal)) {
                    var oldClasses = arrayClasses(oldVal);
                    updateClasses(oldClasses, newClasses);
                  }
                }
                oldVal = shallowCopy(newVal);
              }
            }
          };
          function arrayDifference(tokens1, tokens2) {
            var values = [];
            outer: for (var i = 0; i < tokens1.length; i++) {
              var token = tokens1[i];
              for (var j = 0; j < tokens2.length; j++) {
                if (token == tokens2[j])
                  continue outer;
              }
              values.push(token);
            }
            return values;
          }
          function arrayClasses(classVal) {
            var classes = [];
            if (isArray(classVal)) {
              forEach(classVal, function(v) {
                classes = classes.concat(arrayClasses(v));
              });
              return classes;
            } else if (isString(classVal)) {
              return classVal.split(' ');
            } else if (isObject(classVal)) {
              forEach(classVal, function(v, k) {
                if (v) {
                  classes = classes.concat(k.split(' '));
                }
              });
              return classes;
            }
            return classVal;
          }
        }];
      }
      var ngClassDirective = classDirective('', true);
      var ngClassOddDirective = classDirective('Odd', 0);
      var ngClassEvenDirective = classDirective('Even', 1);
      var ngCloakDirective = ngDirective({compile: function(element, attr) {
          attr.$set('ngCloak', undefined);
          element.removeClass('ng-cloak');
        }});
      var ngControllerDirective = [function() {
        return {
          restrict: 'A',
          scope: true,
          controller: '@',
          priority: 500
        };
      }];
      var ngEventDirectives = {};
      var forceAsyncEvents = {
        'blur': true,
        'focus': true
      };
      forEach('click dblclick mousedown mouseup mouseover mouseout mousemove mouseenter mouseleave keydown keyup keypress submit focus blur copy cut paste'.split(' '), function(eventName) {
        var directiveName = directiveNormalize('ng-' + eventName);
        ngEventDirectives[directiveName] = ['$parse', '$rootScope', function($parse, $rootScope) {
          return {
            restrict: 'A',
            compile: function($element, attr) {
              var fn = $parse(attr[directiveName], null, true);
              return function ngEventHandler(scope, element) {
                element.on(eventName, function(event) {
                  var callback = function() {
                    fn(scope, {$event: event});
                  };
                  if (forceAsyncEvents[eventName] && $rootScope.$$phase) {
                    scope.$evalAsync(callback);
                  } else {
                    scope.$apply(callback);
                  }
                });
              };
            }
          };
        }];
      });
      var ngIfDirective = ['$animate', function($animate) {
        return {
          multiElement: true,
          transclude: 'element',
          priority: 600,
          terminal: true,
          restrict: 'A',
          $$tlb: true,
          link: function($scope, $element, $attr, ctrl, $transclude) {
            var block,
                childScope,
                previousElements;
            $scope.$watch($attr.ngIf, function ngIfWatchAction(value) {
              if (value) {
                if (!childScope) {
                  $transclude(function(clone, newScope) {
                    childScope = newScope;
                    clone[clone.length++] = document.createComment(' end ngIf: ' + $attr.ngIf + ' ');
                    block = {clone: clone};
                    $animate.enter(clone, $element.parent(), $element);
                  });
                }
              } else {
                if (previousElements) {
                  previousElements.remove();
                  previousElements = null;
                }
                if (childScope) {
                  childScope.$destroy();
                  childScope = null;
                }
                if (block) {
                  previousElements = getBlockNodes(block.clone);
                  $animate.leave(previousElements).then(function() {
                    previousElements = null;
                  });
                  block = null;
                }
              }
            });
          }
        };
      }];
      var ngIncludeDirective = ['$templateRequest', '$anchorScroll', '$animate', '$sce', function($templateRequest, $anchorScroll, $animate, $sce) {
        return {
          restrict: 'ECA',
          priority: 400,
          terminal: true,
          transclude: 'element',
          controller: angular.noop,
          compile: function(element, attr) {
            var srcExp = attr.ngInclude || attr.src,
                onloadExp = attr.onload || '',
                autoScrollExp = attr.autoscroll;
            return function(scope, $element, $attr, ctrl, $transclude) {
              var changeCounter = 0,
                  currentScope,
                  previousElement,
                  currentElement;
              var cleanupLastIncludeContent = function() {
                if (previousElement) {
                  previousElement.remove();
                  previousElement = null;
                }
                if (currentScope) {
                  currentScope.$destroy();
                  currentScope = null;
                }
                if (currentElement) {
                  $animate.leave(currentElement).then(function() {
                    previousElement = null;
                  });
                  previousElement = currentElement;
                  currentElement = null;
                }
              };
              scope.$watch($sce.parseAsResourceUrl(srcExp), function ngIncludeWatchAction(src) {
                var afterAnimation = function() {
                  if (isDefined(autoScrollExp) && (!autoScrollExp || scope.$eval(autoScrollExp))) {
                    $anchorScroll();
                  }
                };
                var thisChangeId = ++changeCounter;
                if (src) {
                  $templateRequest(src, true).then(function(response) {
                    if (thisChangeId !== changeCounter)
                      return ;
                    var newScope = scope.$new();
                    ctrl.template = response;
                    var clone = $transclude(newScope, function(clone) {
                      cleanupLastIncludeContent();
                      $animate.enter(clone, null, $element).then(afterAnimation);
                    });
                    currentScope = newScope;
                    currentElement = clone;
                    currentScope.$emit('$includeContentLoaded', src);
                    scope.$eval(onloadExp);
                  }, function() {
                    if (thisChangeId === changeCounter) {
                      cleanupLastIncludeContent();
                      scope.$emit('$includeContentError', src);
                    }
                  });
                  scope.$emit('$includeContentRequested', src);
                } else {
                  cleanupLastIncludeContent();
                  ctrl.template = null;
                }
              });
            };
          }
        };
      }];
      var ngIncludeFillContentDirective = ['$compile', function($compile) {
        return {
          restrict: 'ECA',
          priority: -400,
          require: 'ngInclude',
          link: function(scope, $element, $attr, ctrl) {
            if (/SVG/.test($element[0].toString())) {
              $element.empty();
              $compile(jqLiteBuildFragment(ctrl.template, document).childNodes)(scope, function namespaceAdaptedClone(clone) {
                $element.append(clone);
              }, {futureParentElement: $element});
              return ;
            }
            $element.html(ctrl.template);
            $compile($element.contents())(scope);
          }
        };
      }];
      var ngInitDirective = ngDirective({
        priority: 450,
        compile: function() {
          return {pre: function(scope, element, attrs) {
              scope.$eval(attrs.ngInit);
            }};
        }
      });
      var ngListDirective = function() {
        return {
          restrict: 'A',
          priority: 100,
          require: 'ngModel',
          link: function(scope, element, attr, ctrl) {
            var ngList = element.attr(attr.$attr.ngList) || ', ';
            var trimValues = attr.ngTrim !== 'false';
            var separator = trimValues ? trim(ngList) : ngList;
            var parse = function(viewValue) {
              if (isUndefined(viewValue))
                return ;
              var list = [];
              if (viewValue) {
                forEach(viewValue.split(separator), function(value) {
                  if (value)
                    list.push(trimValues ? trim(value) : value);
                });
              }
              return list;
            };
            ctrl.$parsers.push(parse);
            ctrl.$formatters.push(function(value) {
              if (isArray(value)) {
                return value.join(ngList);
              }
              return undefined;
            });
            ctrl.$isEmpty = function(value) {
              return !value || !value.length;
            };
          }
        };
      };
      var VALID_CLASS = 'ng-valid',
          INVALID_CLASS = 'ng-invalid',
          PRISTINE_CLASS = 'ng-pristine',
          DIRTY_CLASS = 'ng-dirty',
          UNTOUCHED_CLASS = 'ng-untouched',
          TOUCHED_CLASS = 'ng-touched',
          PENDING_CLASS = 'ng-pending';
      var $ngModelMinErr = new minErr('ngModel');
      var NgModelController = ['$scope', '$exceptionHandler', '$attrs', '$element', '$parse', '$animate', '$timeout', '$rootScope', '$q', '$interpolate', function($scope, $exceptionHandler, $attr, $element, $parse, $animate, $timeout, $rootScope, $q, $interpolate) {
        this.$viewValue = Number.NaN;
        this.$modelValue = Number.NaN;
        this.$$rawModelValue = undefined;
        this.$validators = {};
        this.$asyncValidators = {};
        this.$parsers = [];
        this.$formatters = [];
        this.$viewChangeListeners = [];
        this.$untouched = true;
        this.$touched = false;
        this.$pristine = true;
        this.$dirty = false;
        this.$valid = true;
        this.$invalid = false;
        this.$error = {};
        this.$$success = {};
        this.$pending = undefined;
        this.$name = $interpolate($attr.name || '', false)($scope);
        var parsedNgModel = $parse($attr.ngModel),
            parsedNgModelAssign = parsedNgModel.assign,
            ngModelGet = parsedNgModel,
            ngModelSet = parsedNgModelAssign,
            pendingDebounce = null,
            parserValid,
            ctrl = this;
        this.$$setOptions = function(options) {
          ctrl.$options = options;
          if (options && options.getterSetter) {
            var invokeModelGetter = $parse($attr.ngModel + '()'),
                invokeModelSetter = $parse($attr.ngModel + '($$$p)');
            ngModelGet = function($scope) {
              var modelValue = parsedNgModel($scope);
              if (isFunction(modelValue)) {
                modelValue = invokeModelGetter($scope);
              }
              return modelValue;
            };
            ngModelSet = function($scope, newValue) {
              if (isFunction(parsedNgModel($scope))) {
                invokeModelSetter($scope, {$$$p: ctrl.$modelValue});
              } else {
                parsedNgModelAssign($scope, ctrl.$modelValue);
              }
            };
          } else if (!parsedNgModel.assign) {
            throw $ngModelMinErr('nonassign', "Expression '{0}' is non-assignable. Element: {1}", $attr.ngModel, startingTag($element));
          }
        };
        this.$render = noop;
        this.$isEmpty = function(value) {
          return isUndefined(value) || value === '' || value === null || value !== value;
        };
        var parentForm = $element.inheritedData('$formController') || nullFormCtrl,
            currentValidationRunId = 0;
        addSetValidityMethod({
          ctrl: this,
          $element: $element,
          set: function(object, property) {
            object[property] = true;
          },
          unset: function(object, property) {
            delete object[property];
          },
          parentForm: parentForm,
          $animate: $animate
        });
        this.$setPristine = function() {
          ctrl.$dirty = false;
          ctrl.$pristine = true;
          $animate.removeClass($element, DIRTY_CLASS);
          $animate.addClass($element, PRISTINE_CLASS);
        };
        this.$setDirty = function() {
          ctrl.$dirty = true;
          ctrl.$pristine = false;
          $animate.removeClass($element, PRISTINE_CLASS);
          $animate.addClass($element, DIRTY_CLASS);
          parentForm.$setDirty();
        };
        this.$setUntouched = function() {
          ctrl.$touched = false;
          ctrl.$untouched = true;
          $animate.setClass($element, UNTOUCHED_CLASS, TOUCHED_CLASS);
        };
        this.$setTouched = function() {
          ctrl.$touched = true;
          ctrl.$untouched = false;
          $animate.setClass($element, TOUCHED_CLASS, UNTOUCHED_CLASS);
        };
        this.$rollbackViewValue = function() {
          $timeout.cancel(pendingDebounce);
          ctrl.$viewValue = ctrl.$$lastCommittedViewValue;
          ctrl.$render();
        };
        this.$validate = function() {
          if (isNumber(ctrl.$modelValue) && isNaN(ctrl.$modelValue)) {
            return ;
          }
          var viewValue = ctrl.$$lastCommittedViewValue;
          var modelValue = ctrl.$$rawModelValue;
          var prevValid = ctrl.$valid;
          var prevModelValue = ctrl.$modelValue;
          var allowInvalid = ctrl.$options && ctrl.$options.allowInvalid;
          ctrl.$$runValidators(modelValue, viewValue, function(allValid) {
            if (!allowInvalid && prevValid !== allValid) {
              ctrl.$modelValue = allValid ? modelValue : undefined;
              if (ctrl.$modelValue !== prevModelValue) {
                ctrl.$$writeModelToScope();
              }
            }
          });
        };
        this.$$runValidators = function(modelValue, viewValue, doneCallback) {
          currentValidationRunId++;
          var localValidationRunId = currentValidationRunId;
          if (!processParseErrors()) {
            validationDone(false);
            return ;
          }
          if (!processSyncValidators()) {
            validationDone(false);
            return ;
          }
          processAsyncValidators();
          function processParseErrors() {
            var errorKey = ctrl.$$parserName || 'parse';
            if (parserValid === undefined) {
              setValidity(errorKey, null);
            } else {
              if (!parserValid) {
                forEach(ctrl.$validators, function(v, name) {
                  setValidity(name, null);
                });
                forEach(ctrl.$asyncValidators, function(v, name) {
                  setValidity(name, null);
                });
              }
              setValidity(errorKey, parserValid);
              return parserValid;
            }
            return true;
          }
          function processSyncValidators() {
            var syncValidatorsValid = true;
            forEach(ctrl.$validators, function(validator, name) {
              var result = validator(modelValue, viewValue);
              syncValidatorsValid = syncValidatorsValid && result;
              setValidity(name, result);
            });
            if (!syncValidatorsValid) {
              forEach(ctrl.$asyncValidators, function(v, name) {
                setValidity(name, null);
              });
              return false;
            }
            return true;
          }
          function processAsyncValidators() {
            var validatorPromises = [];
            var allValid = true;
            forEach(ctrl.$asyncValidators, function(validator, name) {
              var promise = validator(modelValue, viewValue);
              if (!isPromiseLike(promise)) {
                throw $ngModelMinErr("$asyncValidators", "Expected asynchronous validator to return a promise but got '{0}' instead.", promise);
              }
              setValidity(name, undefined);
              validatorPromises.push(promise.then(function() {
                setValidity(name, true);
              }, function(error) {
                allValid = false;
                setValidity(name, false);
              }));
            });
            if (!validatorPromises.length) {
              validationDone(true);
            } else {
              $q.all(validatorPromises).then(function() {
                validationDone(allValid);
              }, noop);
            }
          }
          function setValidity(name, isValid) {
            if (localValidationRunId === currentValidationRunId) {
              ctrl.$setValidity(name, isValid);
            }
          }
          function validationDone(allValid) {
            if (localValidationRunId === currentValidationRunId) {
              doneCallback(allValid);
            }
          }
        };
        this.$commitViewValue = function() {
          var viewValue = ctrl.$viewValue;
          $timeout.cancel(pendingDebounce);
          if (ctrl.$$lastCommittedViewValue === viewValue && (viewValue !== '' || !ctrl.$$hasNativeValidators)) {
            return ;
          }
          ctrl.$$lastCommittedViewValue = viewValue;
          if (ctrl.$pristine) {
            this.$setDirty();
          }
          this.$$parseAndValidate();
        };
        this.$$parseAndValidate = function() {
          var viewValue = ctrl.$$lastCommittedViewValue;
          var modelValue = viewValue;
          parserValid = isUndefined(modelValue) ? undefined : true;
          if (parserValid) {
            for (var i = 0; i < ctrl.$parsers.length; i++) {
              modelValue = ctrl.$parsers[i](modelValue);
              if (isUndefined(modelValue)) {
                parserValid = false;
                break;
              }
            }
          }
          if (isNumber(ctrl.$modelValue) && isNaN(ctrl.$modelValue)) {
            ctrl.$modelValue = ngModelGet($scope);
          }
          var prevModelValue = ctrl.$modelValue;
          var allowInvalid = ctrl.$options && ctrl.$options.allowInvalid;
          ctrl.$$rawModelValue = modelValue;
          if (allowInvalid) {
            ctrl.$modelValue = modelValue;
            writeToModelIfNeeded();
          }
          ctrl.$$runValidators(modelValue, ctrl.$$lastCommittedViewValue, function(allValid) {
            if (!allowInvalid) {
              ctrl.$modelValue = allValid ? modelValue : undefined;
              writeToModelIfNeeded();
            }
          });
          function writeToModelIfNeeded() {
            if (ctrl.$modelValue !== prevModelValue) {
              ctrl.$$writeModelToScope();
            }
          }
        };
        this.$$writeModelToScope = function() {
          ngModelSet($scope, ctrl.$modelValue);
          forEach(ctrl.$viewChangeListeners, function(listener) {
            try {
              listener();
            } catch (e) {
              $exceptionHandler(e);
            }
          });
        };
        this.$setViewValue = function(value, trigger) {
          ctrl.$viewValue = value;
          if (!ctrl.$options || ctrl.$options.updateOnDefault) {
            ctrl.$$debounceViewValueCommit(trigger);
          }
        };
        this.$$debounceViewValueCommit = function(trigger) {
          var debounceDelay = 0,
              options = ctrl.$options,
              debounce;
          if (options && isDefined(options.debounce)) {
            debounce = options.debounce;
            if (isNumber(debounce)) {
              debounceDelay = debounce;
            } else if (isNumber(debounce[trigger])) {
              debounceDelay = debounce[trigger];
            } else if (isNumber(debounce['default'])) {
              debounceDelay = debounce['default'];
            }
          }
          $timeout.cancel(pendingDebounce);
          if (debounceDelay) {
            pendingDebounce = $timeout(function() {
              ctrl.$commitViewValue();
            }, debounceDelay);
          } else if ($rootScope.$$phase) {
            ctrl.$commitViewValue();
          } else {
            $scope.$apply(function() {
              ctrl.$commitViewValue();
            });
          }
        };
        $scope.$watch(function ngModelWatch() {
          var modelValue = ngModelGet($scope);
          if (modelValue !== ctrl.$modelValue && (ctrl.$modelValue === ctrl.$modelValue || modelValue === modelValue)) {
            ctrl.$modelValue = ctrl.$$rawModelValue = modelValue;
            parserValid = undefined;
            var formatters = ctrl.$formatters,
                idx = formatters.length;
            var viewValue = modelValue;
            while (idx--) {
              viewValue = formatters[idx](viewValue);
            }
            if (ctrl.$viewValue !== viewValue) {
              ctrl.$viewValue = ctrl.$$lastCommittedViewValue = viewValue;
              ctrl.$render();
              ctrl.$$runValidators(modelValue, viewValue, noop);
            }
          }
          return modelValue;
        });
      }];
      var ngModelDirective = ['$rootScope', function($rootScope) {
        return {
          restrict: 'A',
          require: ['ngModel', '^?form', '^?ngModelOptions'],
          controller: NgModelController,
          priority: 1,
          compile: function ngModelCompile(element) {
            element.addClass(PRISTINE_CLASS).addClass(UNTOUCHED_CLASS).addClass(VALID_CLASS);
            return {
              pre: function ngModelPreLink(scope, element, attr, ctrls) {
                var modelCtrl = ctrls[0],
                    formCtrl = ctrls[1] || nullFormCtrl;
                modelCtrl.$$setOptions(ctrls[2] && ctrls[2].$options);
                formCtrl.$addControl(modelCtrl);
                attr.$observe('name', function(newValue) {
                  if (modelCtrl.$name !== newValue) {
                    formCtrl.$$renameControl(modelCtrl, newValue);
                  }
                });
                scope.$on('$destroy', function() {
                  formCtrl.$removeControl(modelCtrl);
                });
              },
              post: function ngModelPostLink(scope, element, attr, ctrls) {
                var modelCtrl = ctrls[0];
                if (modelCtrl.$options && modelCtrl.$options.updateOn) {
                  element.on(modelCtrl.$options.updateOn, function(ev) {
                    modelCtrl.$$debounceViewValueCommit(ev && ev.type);
                  });
                }
                element.on('blur', function(ev) {
                  if (modelCtrl.$touched)
                    return ;
                  if ($rootScope.$$phase) {
                    scope.$evalAsync(modelCtrl.$setTouched);
                  } else {
                    scope.$apply(modelCtrl.$setTouched);
                  }
                });
              }
            };
          }
        };
      }];
      var DEFAULT_REGEXP = /(\s+|^)default(\s+|$)/;
      var ngModelOptionsDirective = function() {
        return {
          restrict: 'A',
          controller: ['$scope', '$attrs', function($scope, $attrs) {
            var that = this;
            this.$options = copy($scope.$eval($attrs.ngModelOptions));
            if (this.$options.updateOn !== undefined) {
              this.$options.updateOnDefault = false;
              this.$options.updateOn = trim(this.$options.updateOn.replace(DEFAULT_REGEXP, function() {
                that.$options.updateOnDefault = true;
                return ' ';
              }));
            } else {
              this.$options.updateOnDefault = true;
            }
          }]
        };
      };
      function addSetValidityMethod(context) {
        var ctrl = context.ctrl,
            $element = context.$element,
            classCache = {},
            set = context.set,
            unset = context.unset,
            parentForm = context.parentForm,
            $animate = context.$animate;
        classCache[INVALID_CLASS] = !(classCache[VALID_CLASS] = $element.hasClass(VALID_CLASS));
        ctrl.$setValidity = setValidity;
        function setValidity(validationErrorKey, state, controller) {
          if (state === undefined) {
            createAndSet('$pending', validationErrorKey, controller);
          } else {
            unsetAndCleanup('$pending', validationErrorKey, controller);
          }
          if (!isBoolean(state)) {
            unset(ctrl.$error, validationErrorKey, controller);
            unset(ctrl.$$success, validationErrorKey, controller);
          } else {
            if (state) {
              unset(ctrl.$error, validationErrorKey, controller);
              set(ctrl.$$success, validationErrorKey, controller);
            } else {
              set(ctrl.$error, validationErrorKey, controller);
              unset(ctrl.$$success, validationErrorKey, controller);
            }
          }
          if (ctrl.$pending) {
            cachedToggleClass(PENDING_CLASS, true);
            ctrl.$valid = ctrl.$invalid = undefined;
            toggleValidationCss('', null);
          } else {
            cachedToggleClass(PENDING_CLASS, false);
            ctrl.$valid = isObjectEmpty(ctrl.$error);
            ctrl.$invalid = !ctrl.$valid;
            toggleValidationCss('', ctrl.$valid);
          }
          var combinedState;
          if (ctrl.$pending && ctrl.$pending[validationErrorKey]) {
            combinedState = undefined;
          } else if (ctrl.$error[validationErrorKey]) {
            combinedState = false;
          } else if (ctrl.$$success[validationErrorKey]) {
            combinedState = true;
          } else {
            combinedState = null;
          }
          toggleValidationCss(validationErrorKey, combinedState);
          parentForm.$setValidity(validationErrorKey, combinedState, ctrl);
        }
        function createAndSet(name, value, controller) {
          if (!ctrl[name]) {
            ctrl[name] = {};
          }
          set(ctrl[name], value, controller);
        }
        function unsetAndCleanup(name, value, controller) {
          if (ctrl[name]) {
            unset(ctrl[name], value, controller);
          }
          if (isObjectEmpty(ctrl[name])) {
            ctrl[name] = undefined;
          }
        }
        function cachedToggleClass(className, switchValue) {
          if (switchValue && !classCache[className]) {
            $animate.addClass($element, className);
            classCache[className] = true;
          } else if (!switchValue && classCache[className]) {
            $animate.removeClass($element, className);
            classCache[className] = false;
          }
        }
        function toggleValidationCss(validationErrorKey, isValid) {
          validationErrorKey = validationErrorKey ? '-' + snake_case(validationErrorKey, '-') : '';
          cachedToggleClass(VALID_CLASS + validationErrorKey, isValid === true);
          cachedToggleClass(INVALID_CLASS + validationErrorKey, isValid === false);
        }
      }
      function isObjectEmpty(obj) {
        if (obj) {
          for (var prop in obj) {
            if (obj.hasOwnProperty(prop)) {
              return false;
            }
          }
        }
        return true;
      }
      var ngNonBindableDirective = ngDirective({
        terminal: true,
        priority: 1000
      });
      var ngOptionsMinErr = minErr('ngOptions');
      var NG_OPTIONS_REGEXP = /^\s*([\s\S]+?)(?:\s+as\s+([\s\S]+?))?(?:\s+group\s+by\s+([\s\S]+?))?(?:\s+disable\s+when\s+([\s\S]+?))?\s+for\s+(?:([\$\w][\$\w]*)|(?:\(\s*([\$\w][\$\w]*)\s*,\s*([\$\w][\$\w]*)\s*\)))\s+in\s+([\s\S]+?)(?:\s+track\s+by\s+([\s\S]+?))?$/;
      var ngOptionsDirective = ['$compile', '$parse', function($compile, $parse) {
        function parseOptionsExpression(optionsExp, selectElement, scope) {
          var match = optionsExp.match(NG_OPTIONS_REGEXP);
          if (!(match)) {
            throw ngOptionsMinErr('iexp', "Expected expression in form of " + "'_select_ (as _label_)? for (_key_,)?_value_ in _collection_'" + " but got '{0}'. Element: {1}", optionsExp, startingTag(selectElement));
          }
          var valueName = match[5] || match[7];
          var keyName = match[6];
          var selectAs = / as /.test(match[0]) && match[1];
          var trackBy = match[9];
          var valueFn = $parse(match[2] ? match[1] : valueName);
          var selectAsFn = selectAs && $parse(selectAs);
          var viewValueFn = selectAsFn || valueFn;
          var trackByFn = trackBy && $parse(trackBy);
          var getTrackByValueFn = trackBy ? function(value, locals) {
            return trackByFn(scope, locals);
          } : function getHashOfValue(value) {
            return hashKey(value);
          };
          var getTrackByValue = function(value, key) {
            return getTrackByValueFn(value, getLocals(value, key));
          };
          var displayFn = $parse(match[2] || match[1]);
          var groupByFn = $parse(match[3] || '');
          var disableWhenFn = $parse(match[4] || '');
          var valuesFn = $parse(match[8]);
          var locals = {};
          var getLocals = keyName ? function(value, key) {
            locals[keyName] = key;
            locals[valueName] = value;
            return locals;
          } : function(value) {
            locals[valueName] = value;
            return locals;
          };
          function Option(selectValue, viewValue, label, group, disabled) {
            this.selectValue = selectValue;
            this.viewValue = viewValue;
            this.label = label;
            this.group = group;
            this.disabled = disabled;
          }
          return {
            trackBy: trackBy,
            getTrackByValue: getTrackByValue,
            getWatchables: $parse(valuesFn, function(values) {
              var watchedArray = [];
              values = values || [];
              Object.keys(values).forEach(function getWatchable(key) {
                if (key.charAt(0) === '$')
                  return ;
                var locals = getLocals(values[key], key);
                var selectValue = getTrackByValueFn(values[key], locals);
                watchedArray.push(selectValue);
                if (match[2] || match[1]) {
                  var label = displayFn(scope, locals);
                  watchedArray.push(label);
                }
                if (match[4]) {
                  var disableWhen = disableWhenFn(scope, locals);
                  watchedArray.push(disableWhen);
                }
              });
              return watchedArray;
            }),
            getOptions: function() {
              var optionItems = [];
              var selectValueMap = {};
              var optionValues = valuesFn(scope) || [];
              var optionValuesKeys;
              if (!keyName && isArrayLike(optionValues)) {
                optionValuesKeys = optionValues;
              } else {
                optionValuesKeys = [];
                for (var itemKey in optionValues) {
                  if (optionValues.hasOwnProperty(itemKey) && itemKey.charAt(0) !== '$') {
                    optionValuesKeys.push(itemKey);
                  }
                }
              }
              var optionValuesLength = optionValuesKeys.length;
              for (var index = 0; index < optionValuesLength; index++) {
                var key = (optionValues === optionValuesKeys) ? index : optionValuesKeys[index];
                var value = optionValues[key];
                var locals = getLocals(value, key);
                var viewValue = viewValueFn(scope, locals);
                var selectValue = getTrackByValueFn(viewValue, locals);
                var label = displayFn(scope, locals);
                var group = groupByFn(scope, locals);
                var disabled = disableWhenFn(scope, locals);
                var optionItem = new Option(selectValue, viewValue, label, group, disabled);
                optionItems.push(optionItem);
                selectValueMap[selectValue] = optionItem;
              }
              return {
                items: optionItems,
                selectValueMap: selectValueMap,
                getOptionFromViewValue: function(value) {
                  return selectValueMap[getTrackByValue(value)];
                },
                getViewValueFromOption: function(option) {
                  return trackBy ? angular.copy(option.viewValue) : option.viewValue;
                }
              };
            }
          };
        }
        var optionTemplate = document.createElement('option'),
            optGroupTemplate = document.createElement('optgroup');
        return {
          restrict: 'A',
          terminal: true,
          require: ['select', '?ngModel'],
          link: function(scope, selectElement, attr, ctrls) {
            var ngModelCtrl = ctrls[1];
            if (!ngModelCtrl)
              return ;
            var selectCtrl = ctrls[0];
            var multiple = attr.multiple;
            var emptyOption;
            for (var i = 0,
                children = selectElement.children(),
                ii = children.length; i < ii; i++) {
              if (children[i].value === '') {
                emptyOption = children.eq(i);
                break;
              }
            }
            var providedEmptyOption = !!emptyOption;
            var unknownOption = jqLite(optionTemplate.cloneNode(false));
            unknownOption.val('?');
            var options;
            var ngOptions = parseOptionsExpression(attr.ngOptions, selectElement, scope);
            var renderEmptyOption = function() {
              if (!providedEmptyOption) {
                selectElement.prepend(emptyOption);
              }
              selectElement.val('');
              emptyOption.prop('selected', true);
              emptyOption.attr('selected', true);
            };
            var removeEmptyOption = function() {
              if (!providedEmptyOption) {
                emptyOption.remove();
              }
            };
            var renderUnknownOption = function() {
              selectElement.prepend(unknownOption);
              selectElement.val('?');
              unknownOption.prop('selected', true);
              unknownOption.attr('selected', true);
            };
            var removeUnknownOption = function() {
              unknownOption.remove();
            };
            if (!multiple) {
              selectCtrl.writeValue = function writeNgOptionsValue(value) {
                var option = options.getOptionFromViewValue(value);
                if (option && !option.disabled) {
                  if (selectElement[0].value !== option.selectValue) {
                    removeUnknownOption();
                    removeEmptyOption();
                    selectElement[0].value = option.selectValue;
                    option.element.selected = true;
                    option.element.setAttribute('selected', 'selected');
                  }
                } else {
                  if (value === null || providedEmptyOption) {
                    removeUnknownOption();
                    renderEmptyOption();
                  } else {
                    removeEmptyOption();
                    renderUnknownOption();
                  }
                }
              };
              selectCtrl.readValue = function readNgOptionsValue() {
                var selectedOption = options.selectValueMap[selectElement.val()];
                if (selectedOption && !selectedOption.disabled) {
                  removeEmptyOption();
                  removeUnknownOption();
                  return options.getViewValueFromOption(selectedOption);
                }
                return null;
              };
              if (ngOptions.trackBy) {
                scope.$watch(function() {
                  return ngOptions.getTrackByValue(ngModelCtrl.$viewValue);
                }, function() {
                  ngModelCtrl.$render();
                });
              }
            } else {
              ngModelCtrl.$isEmpty = function(value) {
                return !value || value.length === 0;
              };
              selectCtrl.writeValue = function writeNgOptionsMultiple(value) {
                options.items.forEach(function(option) {
                  option.element.selected = false;
                });
                if (value) {
                  value.forEach(function(item) {
                    var option = options.getOptionFromViewValue(item);
                    if (option && !option.disabled)
                      option.element.selected = true;
                  });
                }
              };
              selectCtrl.readValue = function readNgOptionsMultiple() {
                var selectedValues = selectElement.val() || [],
                    selections = [];
                forEach(selectedValues, function(value) {
                  var option = options.selectValueMap[value];
                  if (!option.disabled)
                    selections.push(options.getViewValueFromOption(option));
                });
                return selections;
              };
              if (ngOptions.trackBy) {
                scope.$watchCollection(function() {
                  if (isArray(ngModelCtrl.$viewValue)) {
                    return ngModelCtrl.$viewValue.map(function(value) {
                      return ngOptions.getTrackByValue(value);
                    });
                  }
                }, function() {
                  ngModelCtrl.$render();
                });
              }
            }
            if (providedEmptyOption) {
              emptyOption.remove();
              $compile(emptyOption)(scope);
              emptyOption.removeClass('ng-scope');
            } else {
              emptyOption = jqLite(optionTemplate.cloneNode(false));
            }
            updateOptions();
            scope.$watchCollection(ngOptions.getWatchables, updateOptions);
            function updateOptionElement(option, element) {
              option.element = element;
              element.disabled = option.disabled;
              if (option.value !== element.value)
                element.value = option.selectValue;
              if (option.label !== element.label) {
                element.label = option.label;
                element.textContent = option.label;
              }
            }
            function addOrReuseElement(parent, current, type, templateElement) {
              var element;
              if (current && lowercase(current.nodeName) === type) {
                element = current;
              } else {
                element = templateElement.cloneNode(false);
                if (!current) {
                  parent.appendChild(element);
                } else {
                  parent.insertBefore(element, current);
                }
              }
              return element;
            }
            function removeExcessElements(current) {
              var next;
              while (current) {
                next = current.nextSibling;
                jqLiteRemove(current);
                current = next;
              }
            }
            function skipEmptyAndUnknownOptions(current) {
              var emptyOption_ = emptyOption && emptyOption[0];
              var unknownOption_ = unknownOption && unknownOption[0];
              if (emptyOption_ || unknownOption_) {
                while (current && (current === emptyOption_ || current === unknownOption_)) {
                  current = current.nextSibling;
                }
              }
              return current;
            }
            function updateOptions() {
              var previousValue = options && selectCtrl.readValue();
              options = ngOptions.getOptions();
              var groupMap = {};
              var currentElement = selectElement[0].firstChild;
              if (providedEmptyOption) {
                selectElement.prepend(emptyOption);
              }
              currentElement = skipEmptyAndUnknownOptions(currentElement);
              options.items.forEach(function updateOption(option) {
                var group;
                var groupElement;
                var optionElement;
                if (option.group) {
                  group = groupMap[option.group];
                  if (!group) {
                    groupElement = addOrReuseElement(selectElement[0], currentElement, 'optgroup', optGroupTemplate);
                    currentElement = groupElement.nextSibling;
                    groupElement.label = option.group;
                    group = groupMap[option.group] = {
                      groupElement: groupElement,
                      currentOptionElement: groupElement.firstChild
                    };
                  }
                  optionElement = addOrReuseElement(group.groupElement, group.currentOptionElement, 'option', optionTemplate);
                  updateOptionElement(option, optionElement);
                  group.currentOptionElement = optionElement.nextSibling;
                } else {
                  optionElement = addOrReuseElement(selectElement[0], currentElement, 'option', optionTemplate);
                  updateOptionElement(option, optionElement);
                  currentElement = optionElement.nextSibling;
                }
              });
              Object.keys(groupMap).forEach(function(key) {
                removeExcessElements(groupMap[key].currentOptionElement);
              });
              removeExcessElements(currentElement);
              ngModelCtrl.$render();
              if (!ngModelCtrl.$isEmpty(previousValue)) {
                var nextValue = selectCtrl.readValue();
                if (ngOptions.trackBy ? !equals(previousValue, nextValue) : previousValue !== nextValue) {
                  ngModelCtrl.$setViewValue(nextValue);
                  ngModelCtrl.$render();
                }
              }
            }
          }
        };
      }];
      var ngPluralizeDirective = ['$locale', '$interpolate', '$log', function($locale, $interpolate, $log) {
        var BRACE = /{}/g,
            IS_WHEN = /^when(Minus)?(.+)$/;
        return {link: function(scope, element, attr) {
            var numberExp = attr.count,
                whenExp = attr.$attr.when && element.attr(attr.$attr.when),
                offset = attr.offset || 0,
                whens = scope.$eval(whenExp) || {},
                whensExpFns = {},
                startSymbol = $interpolate.startSymbol(),
                endSymbol = $interpolate.endSymbol(),
                braceReplacement = startSymbol + numberExp + '-' + offset + endSymbol,
                watchRemover = angular.noop,
                lastCount;
            forEach(attr, function(expression, attributeName) {
              var tmpMatch = IS_WHEN.exec(attributeName);
              if (tmpMatch) {
                var whenKey = (tmpMatch[1] ? '-' : '') + lowercase(tmpMatch[2]);
                whens[whenKey] = element.attr(attr.$attr[attributeName]);
              }
            });
            forEach(whens, function(expression, key) {
              whensExpFns[key] = $interpolate(expression.replace(BRACE, braceReplacement));
            });
            scope.$watch(numberExp, function ngPluralizeWatchAction(newVal) {
              var count = parseFloat(newVal);
              var countIsNaN = isNaN(count);
              if (!countIsNaN && !(count in whens)) {
                count = $locale.pluralCat(count - offset);
              }
              if ((count !== lastCount) && !(countIsNaN && isNumber(lastCount) && isNaN(lastCount))) {
                watchRemover();
                var whenExpFn = whensExpFns[count];
                if (isUndefined(whenExpFn)) {
                  if (newVal != null) {
                    $log.debug("ngPluralize: no rule defined for '" + count + "' in " + whenExp);
                  }
                  watchRemover = noop;
                  updateElementText();
                } else {
                  watchRemover = scope.$watch(whenExpFn, updateElementText);
                }
                lastCount = count;
              }
            });
            function updateElementText(newText) {
              element.text(newText || '');
            }
          }};
      }];
      var ngRepeatDirective = ['$parse', '$animate', function($parse, $animate) {
        var NG_REMOVED = '$$NG_REMOVED';
        var ngRepeatMinErr = minErr('ngRepeat');
        var updateScope = function(scope, index, valueIdentifier, value, keyIdentifier, key, arrayLength) {
          scope[valueIdentifier] = value;
          if (keyIdentifier)
            scope[keyIdentifier] = key;
          scope.$index = index;
          scope.$first = (index === 0);
          scope.$last = (index === (arrayLength - 1));
          scope.$middle = !(scope.$first || scope.$last);
          scope.$odd = !(scope.$even = (index & 1) === 0);
        };
        var getBlockStart = function(block) {
          return block.clone[0];
        };
        var getBlockEnd = function(block) {
          return block.clone[block.clone.length - 1];
        };
        return {
          restrict: 'A',
          multiElement: true,
          transclude: 'element',
          priority: 1000,
          terminal: true,
          $$tlb: true,
          compile: function ngRepeatCompile($element, $attr) {
            var expression = $attr.ngRepeat;
            var ngRepeatEndComment = document.createComment(' end ngRepeat: ' + expression + ' ');
            var match = expression.match(/^\s*([\s\S]+?)\s+in\s+([\s\S]+?)(?:\s+as\s+([\s\S]+?))?(?:\s+track\s+by\s+([\s\S]+?))?\s*$/);
            if (!match) {
              throw ngRepeatMinErr('iexp', "Expected expression in form of '_item_ in _collection_[ track by _id_]' but got '{0}'.", expression);
            }
            var lhs = match[1];
            var rhs = match[2];
            var aliasAs = match[3];
            var trackByExp = match[4];
            match = lhs.match(/^(?:(\s*[\$\w]+)|\(\s*([\$\w]+)\s*,\s*([\$\w]+)\s*\))$/);
            if (!match) {
              throw ngRepeatMinErr('iidexp', "'_item_' in '_item_ in _collection_' should be an identifier or '(_key_, _value_)' expression, but got '{0}'.", lhs);
            }
            var valueIdentifier = match[3] || match[1];
            var keyIdentifier = match[2];
            if (aliasAs && (!/^[$a-zA-Z_][$a-zA-Z0-9_]*$/.test(aliasAs) || /^(null|undefined|this|\$index|\$first|\$middle|\$last|\$even|\$odd|\$parent|\$root|\$id)$/.test(aliasAs))) {
              throw ngRepeatMinErr('badident', "alias '{0}' is invalid --- must be a valid JS identifier which is not a reserved name.", aliasAs);
            }
            var trackByExpGetter,
                trackByIdExpFn,
                trackByIdArrayFn,
                trackByIdObjFn;
            var hashFnLocals = {$id: hashKey};
            if (trackByExp) {
              trackByExpGetter = $parse(trackByExp);
            } else {
              trackByIdArrayFn = function(key, value) {
                return hashKey(value);
              };
              trackByIdObjFn = function(key) {
                return key;
              };
            }
            return function ngRepeatLink($scope, $element, $attr, ctrl, $transclude) {
              if (trackByExpGetter) {
                trackByIdExpFn = function(key, value, index) {
                  if (keyIdentifier)
                    hashFnLocals[keyIdentifier] = key;
                  hashFnLocals[valueIdentifier] = value;
                  hashFnLocals.$index = index;
                  return trackByExpGetter($scope, hashFnLocals);
                };
              }
              var lastBlockMap = createMap();
              $scope.$watchCollection(rhs, function ngRepeatAction(collection) {
                var index,
                    length,
                    previousNode = $element[0],
                    nextNode,
                    nextBlockMap = createMap(),
                    collectionLength,
                    key,
                    value,
                    trackById,
                    trackByIdFn,
                    collectionKeys,
                    block,
                    nextBlockOrder,
                    elementsToRemove;
                if (aliasAs) {
                  $scope[aliasAs] = collection;
                }
                if (isArrayLike(collection)) {
                  collectionKeys = collection;
                  trackByIdFn = trackByIdExpFn || trackByIdArrayFn;
                } else {
                  trackByIdFn = trackByIdExpFn || trackByIdObjFn;
                  collectionKeys = [];
                  for (var itemKey in collection) {
                    if (collection.hasOwnProperty(itemKey) && itemKey.charAt(0) !== '$') {
                      collectionKeys.push(itemKey);
                    }
                  }
                }
                collectionLength = collectionKeys.length;
                nextBlockOrder = new Array(collectionLength);
                for (index = 0; index < collectionLength; index++) {
                  key = (collection === collectionKeys) ? index : collectionKeys[index];
                  value = collection[key];
                  trackById = trackByIdFn(key, value, index);
                  if (lastBlockMap[trackById]) {
                    block = lastBlockMap[trackById];
                    delete lastBlockMap[trackById];
                    nextBlockMap[trackById] = block;
                    nextBlockOrder[index] = block;
                  } else if (nextBlockMap[trackById]) {
                    forEach(nextBlockOrder, function(block) {
                      if (block && block.scope)
                        lastBlockMap[block.id] = block;
                    });
                    throw ngRepeatMinErr('dupes', "Duplicates in a repeater are not allowed. Use 'track by' expression to specify unique keys. Repeater: {0}, Duplicate key: {1}, Duplicate value: {2}", expression, trackById, value);
                  } else {
                    nextBlockOrder[index] = {
                      id: trackById,
                      scope: undefined,
                      clone: undefined
                    };
                    nextBlockMap[trackById] = true;
                  }
                }
                for (var blockKey in lastBlockMap) {
                  block = lastBlockMap[blockKey];
                  elementsToRemove = getBlockNodes(block.clone);
                  $animate.leave(elementsToRemove);
                  if (elementsToRemove[0].parentNode) {
                    for (index = 0, length = elementsToRemove.length; index < length; index++) {
                      elementsToRemove[index][NG_REMOVED] = true;
                    }
                  }
                  block.scope.$destroy();
                }
                for (index = 0; index < collectionLength; index++) {
                  key = (collection === collectionKeys) ? index : collectionKeys[index];
                  value = collection[key];
                  block = nextBlockOrder[index];
                  if (block.scope) {
                    nextNode = previousNode;
                    do {
                      nextNode = nextNode.nextSibling;
                    } while (nextNode && nextNode[NG_REMOVED]);
                    if (getBlockStart(block) != nextNode) {
                      $animate.move(getBlockNodes(block.clone), null, jqLite(previousNode));
                    }
                    previousNode = getBlockEnd(block);
                    updateScope(block.scope, index, valueIdentifier, value, keyIdentifier, key, collectionLength);
                  } else {
                    $transclude(function ngRepeatTransclude(clone, scope) {
                      block.scope = scope;
                      var endNode = ngRepeatEndComment.cloneNode(false);
                      clone[clone.length++] = endNode;
                      $animate.enter(clone, null, jqLite(previousNode));
                      previousNode = endNode;
                      block.clone = clone;
                      nextBlockMap[block.id] = block;
                      updateScope(block.scope, index, valueIdentifier, value, keyIdentifier, key, collectionLength);
                    });
                  }
                }
                lastBlockMap = nextBlockMap;
              });
            };
          }
        };
      }];
      var NG_HIDE_CLASS = 'ng-hide';
      var NG_HIDE_IN_PROGRESS_CLASS = 'ng-hide-animate';
      var ngShowDirective = ['$animate', function($animate) {
        return {
          restrict: 'A',
          multiElement: true,
          link: function(scope, element, attr) {
            scope.$watch(attr.ngShow, function ngShowWatchAction(value) {
              $animate[value ? 'removeClass' : 'addClass'](element, NG_HIDE_CLASS, {tempClasses: NG_HIDE_IN_PROGRESS_CLASS});
            });
          }
        };
      }];
      var ngHideDirective = ['$animate', function($animate) {
        return {
          restrict: 'A',
          multiElement: true,
          link: function(scope, element, attr) {
            scope.$watch(attr.ngHide, function ngHideWatchAction(value) {
              $animate[value ? 'addClass' : 'removeClass'](element, NG_HIDE_CLASS, {tempClasses: NG_HIDE_IN_PROGRESS_CLASS});
            });
          }
        };
      }];
      var ngStyleDirective = ngDirective(function(scope, element, attr) {
        scope.$watch(attr.ngStyle, function ngStyleWatchAction(newStyles, oldStyles) {
          if (oldStyles && (newStyles !== oldStyles)) {
            forEach(oldStyles, function(val, style) {
              element.css(style, '');
            });
          }
          if (newStyles)
            element.css(newStyles);
        }, true);
      });
      var ngSwitchDirective = ['$animate', function($animate) {
        return {
          require: 'ngSwitch',
          controller: ['$scope', function ngSwitchController() {
            this.cases = {};
          }],
          link: function(scope, element, attr, ngSwitchController) {
            var watchExpr = attr.ngSwitch || attr.on,
                selectedTranscludes = [],
                selectedElements = [],
                previousLeaveAnimations = [],
                selectedScopes = [];
            var spliceFactory = function(array, index) {
              return function() {
                array.splice(index, 1);
              };
            };
            scope.$watch(watchExpr, function ngSwitchWatchAction(value) {
              var i,
                  ii;
              for (i = 0, ii = previousLeaveAnimations.length; i < ii; ++i) {
                $animate.cancel(previousLeaveAnimations[i]);
              }
              previousLeaveAnimations.length = 0;
              for (i = 0, ii = selectedScopes.length; i < ii; ++i) {
                var selected = getBlockNodes(selectedElements[i].clone);
                selectedScopes[i].$destroy();
                var promise = previousLeaveAnimations[i] = $animate.leave(selected);
                promise.then(spliceFactory(previousLeaveAnimations, i));
              }
              selectedElements.length = 0;
              selectedScopes.length = 0;
              if ((selectedTranscludes = ngSwitchController.cases['!' + value] || ngSwitchController.cases['?'])) {
                forEach(selectedTranscludes, function(selectedTransclude) {
                  selectedTransclude.transclude(function(caseElement, selectedScope) {
                    selectedScopes.push(selectedScope);
                    var anchor = selectedTransclude.element;
                    caseElement[caseElement.length++] = document.createComment(' end ngSwitchWhen: ');
                    var block = {clone: caseElement};
                    selectedElements.push(block);
                    $animate.enter(caseElement, anchor.parent(), anchor);
                  });
                });
              }
            });
          }
        };
      }];
      var ngSwitchWhenDirective = ngDirective({
        transclude: 'element',
        priority: 1200,
        require: '^ngSwitch',
        multiElement: true,
        link: function(scope, element, attrs, ctrl, $transclude) {
          ctrl.cases['!' + attrs.ngSwitchWhen] = (ctrl.cases['!' + attrs.ngSwitchWhen] || []);
          ctrl.cases['!' + attrs.ngSwitchWhen].push({
            transclude: $transclude,
            element: element
          });
        }
      });
      var ngSwitchDefaultDirective = ngDirective({
        transclude: 'element',
        priority: 1200,
        require: '^ngSwitch',
        multiElement: true,
        link: function(scope, element, attr, ctrl, $transclude) {
          ctrl.cases['?'] = (ctrl.cases['?'] || []);
          ctrl.cases['?'].push({
            transclude: $transclude,
            element: element
          });
        }
      });
      var ngTranscludeDirective = ngDirective({
        restrict: 'EAC',
        link: function($scope, $element, $attrs, controller, $transclude) {
          if (!$transclude) {
            throw minErr('ngTransclude')('orphan', 'Illegal use of ngTransclude directive in the template! ' + 'No parent directive that requires a transclusion found. ' + 'Element: {0}', startingTag($element));
          }
          $transclude(function(clone) {
            $element.empty();
            $element.append(clone);
          });
        }
      });
      var scriptDirective = ['$templateCache', function($templateCache) {
        return {
          restrict: 'E',
          terminal: true,
          compile: function(element, attr) {
            if (attr.type == 'text/ng-template') {
              var templateUrl = attr.id,
                  text = element[0].text;
              $templateCache.put(templateUrl, text);
            }
          }
        };
      }];
      var noopNgModelController = {
        $setViewValue: noop,
        $render: noop
      };
      var SelectController = ['$element', '$scope', '$attrs', function($element, $scope, $attrs) {
        var self = this,
            optionsMap = new HashMap();
        self.ngModelCtrl = noopNgModelController;
        self.unknownOption = jqLite(document.createElement('option'));
        self.renderUnknownOption = function(val) {
          var unknownVal = '? ' + hashKey(val) + ' ?';
          self.unknownOption.val(unknownVal);
          $element.prepend(self.unknownOption);
          $element.val(unknownVal);
        };
        $scope.$on('$destroy', function() {
          self.renderUnknownOption = noop;
        });
        self.removeUnknownOption = function() {
          if (self.unknownOption.parent())
            self.unknownOption.remove();
        };
        self.readValue = function readSingleValue() {
          self.removeUnknownOption();
          return $element.val();
        };
        self.writeValue = function writeSingleValue(value) {
          if (self.hasOption(value)) {
            self.removeUnknownOption();
            $element.val(value);
            if (value === '')
              self.emptyOption.prop('selected', true);
          } else {
            if (value == null && self.emptyOption) {
              self.removeUnknownOption();
              $element.val('');
            } else {
              self.renderUnknownOption(value);
            }
          }
        };
        self.addOption = function(value, element) {
          assertNotHasOwnProperty(value, '"option value"');
          if (value === '') {
            self.emptyOption = element;
          }
          var count = optionsMap.get(value) || 0;
          optionsMap.put(value, count + 1);
        };
        self.removeOption = function(value) {
          var count = optionsMap.get(value);
          if (count) {
            if (count === 1) {
              optionsMap.remove(value);
              if (value === '') {
                self.emptyOption = undefined;
              }
            } else {
              optionsMap.put(value, count - 1);
            }
          }
        };
        self.hasOption = function(value) {
          return !!optionsMap.get(value);
        };
      }];
      var selectDirective = function() {
        return {
          restrict: 'E',
          require: ['select', '?ngModel'],
          controller: SelectController,
          link: function(scope, element, attr, ctrls) {
            var ngModelCtrl = ctrls[1];
            if (!ngModelCtrl)
              return ;
            var selectCtrl = ctrls[0];
            selectCtrl.ngModelCtrl = ngModelCtrl;
            ngModelCtrl.$render = function() {
              selectCtrl.writeValue(ngModelCtrl.$viewValue);
            };
            element.on('change', function() {
              scope.$apply(function() {
                ngModelCtrl.$setViewValue(selectCtrl.readValue());
              });
            });
            if (attr.multiple) {
              selectCtrl.readValue = function readMultipleValue() {
                var array = [];
                forEach(element.find('option'), function(option) {
                  if (option.selected) {
                    array.push(option.value);
                  }
                });
                return array;
              };
              selectCtrl.writeValue = function writeMultipleValue(value) {
                var items = new HashMap(value);
                forEach(element.find('option'), function(option) {
                  option.selected = isDefined(items.get(option.value));
                });
              };
              var lastView,
                  lastViewRef = NaN;
              scope.$watch(function selectMultipleWatch() {
                if (lastViewRef === ngModelCtrl.$viewValue && !equals(lastView, ngModelCtrl.$viewValue)) {
                  lastView = shallowCopy(ngModelCtrl.$viewValue);
                  ngModelCtrl.$render();
                }
                lastViewRef = ngModelCtrl.$viewValue;
              });
              ngModelCtrl.$isEmpty = function(value) {
                return !value || value.length === 0;
              };
            }
          }
        };
      };
      var optionDirective = ['$interpolate', function($interpolate) {
        function chromeHack(optionElement) {
          if (optionElement[0].hasAttribute('selected')) {
            optionElement[0].selected = true;
          }
        }
        return {
          restrict: 'E',
          priority: 100,
          compile: function(element, attr) {
            if (isUndefined(attr.value)) {
              var interpolateFn = $interpolate(element.text(), true);
              if (!interpolateFn) {
                attr.$set('value', element.text());
              }
            }
            return function(scope, element, attr) {
              var selectCtrlName = '$selectController',
                  parent = element.parent(),
                  selectCtrl = parent.data(selectCtrlName) || parent.parent().data(selectCtrlName);
              if (selectCtrl && selectCtrl.ngModelCtrl) {
                if (interpolateFn) {
                  scope.$watch(interpolateFn, function interpolateWatchAction(newVal, oldVal) {
                    attr.$set('value', newVal);
                    if (oldVal !== newVal) {
                      selectCtrl.removeOption(oldVal);
                    }
                    selectCtrl.addOption(newVal, element);
                    selectCtrl.ngModelCtrl.$render();
                    chromeHack(element);
                  });
                } else {
                  selectCtrl.addOption(attr.value, element);
                  selectCtrl.ngModelCtrl.$render();
                  chromeHack(element);
                }
                element.on('$destroy', function() {
                  selectCtrl.removeOption(attr.value);
                  selectCtrl.ngModelCtrl.$render();
                });
              }
            };
          }
        };
      }];
      var styleDirective = valueFn({
        restrict: 'E',
        terminal: false
      });
      var requiredDirective = function() {
        return {
          restrict: 'A',
          require: '?ngModel',
          link: function(scope, elm, attr, ctrl) {
            if (!ctrl)
              return ;
            attr.required = true;
            ctrl.$validators.required = function(modelValue, viewValue) {
              return !attr.required || !ctrl.$isEmpty(viewValue);
            };
            attr.$observe('required', function() {
              ctrl.$validate();
            });
          }
        };
      };
      var patternDirective = function() {
        return {
          restrict: 'A',
          require: '?ngModel',
          link: function(scope, elm, attr, ctrl) {
            if (!ctrl)
              return ;
            var regexp,
                patternExp = attr.ngPattern || attr.pattern;
            attr.$observe('pattern', function(regex) {
              if (isString(regex) && regex.length > 0) {
                regex = new RegExp('^' + regex + '$');
              }
              if (regex && !regex.test) {
                throw minErr('ngPattern')('noregexp', 'Expected {0} to be a RegExp but was {1}. Element: {2}', patternExp, regex, startingTag(elm));
              }
              regexp = regex || undefined;
              ctrl.$validate();
            });
            ctrl.$validators.pattern = function(value) {
              return ctrl.$isEmpty(value) || isUndefined(regexp) || regexp.test(value);
            };
          }
        };
      };
      var maxlengthDirective = function() {
        return {
          restrict: 'A',
          require: '?ngModel',
          link: function(scope, elm, attr, ctrl) {
            if (!ctrl)
              return ;
            var maxlength = -1;
            attr.$observe('maxlength', function(value) {
              var intVal = toInt(value);
              maxlength = isNaN(intVal) ? -1 : intVal;
              ctrl.$validate();
            });
            ctrl.$validators.maxlength = function(modelValue, viewValue) {
              return (maxlength < 0) || ctrl.$isEmpty(viewValue) || (viewValue.length <= maxlength);
            };
          }
        };
      };
      var minlengthDirective = function() {
        return {
          restrict: 'A',
          require: '?ngModel',
          link: function(scope, elm, attr, ctrl) {
            if (!ctrl)
              return ;
            var minlength = 0;
            attr.$observe('minlength', function(value) {
              minlength = toInt(value) || 0;
              ctrl.$validate();
            });
            ctrl.$validators.minlength = function(modelValue, viewValue) {
              return ctrl.$isEmpty(viewValue) || viewValue.length >= minlength;
            };
          }
        };
      };
      if (window.angular.bootstrap) {
        console.log('WARNING: Tried to load angular more than once.');
        return ;
      }
      bindJQuery();
      publishExternalAPI(angular);
      jqLite(document).ready(function() {
        angularInit(document, bootstrap);
      });
    })(window, document);
    !window.angular.$$csp() && window.angular.element(document).find('head').prepend('<style type="text/css">@charset "UTF-8";[ng\\:cloak],[ng-cloak],[data-ng-cloak],[x-ng-cloak],.ng-cloak,.x-ng-cloak,.ng-hide:not(.ng-hide-animate){display:none !important;}ng\\:form{display:block;}.ng-animate-shim{visibility:hidden;}.ng-anchor{position:absolute;}</style>');
  }).call(System.global);
  return System.get("@@global-helpers").retrieveGlobal(__module.id, "angular");
});

System.register("github:angular/bower-angular-route@1.4.1/angular-route", ["github:angular/bower-angular@1.4.1"], false, function(__require, __exports, __module) {
  System.get("@@global-helpers").prepareGlobal(__module.id, ["github:angular/bower-angular@1.4.1"]);
  (function() {
    "format global";
    "deps angular";
    (function(window, angular, undefined) {
      'use strict';
      var ngRouteModule = angular.module('ngRoute', ['ng']).provider('$route', $RouteProvider),
          $routeMinErr = angular.$$minErr('ngRoute');
      function $RouteProvider() {
        function inherit(parent, extra) {
          return angular.extend(Object.create(parent), extra);
        }
        var routes = {};
        this.when = function(path, route) {
          var routeCopy = angular.copy(route);
          if (angular.isUndefined(routeCopy.reloadOnSearch)) {
            routeCopy.reloadOnSearch = true;
          }
          if (angular.isUndefined(routeCopy.caseInsensitiveMatch)) {
            routeCopy.caseInsensitiveMatch = this.caseInsensitiveMatch;
          }
          routes[path] = angular.extend(routeCopy, path && pathRegExp(path, routeCopy));
          if (path) {
            var redirectPath = (path[path.length - 1] == '/') ? path.substr(0, path.length - 1) : path + '/';
            routes[redirectPath] = angular.extend({redirectTo: path}, pathRegExp(redirectPath, routeCopy));
          }
          return this;
        };
        this.caseInsensitiveMatch = false;
        function pathRegExp(path, opts) {
          var insensitive = opts.caseInsensitiveMatch,
              ret = {
                originalPath: path,
                regexp: path
              },
              keys = ret.keys = [];
          path = path.replace(/([().])/g, '\\$1').replace(/(\/)?:(\w+)([\?\*])?/g, function(_, slash, key, option) {
            var optional = option === '?' ? option : null;
            var star = option === '*' ? option : null;
            keys.push({
              name: key,
              optional: !!optional
            });
            slash = slash || '';
            return '' + (optional ? '' : slash) + '(?:' + (optional ? slash : '') + (star && '(.+?)' || '([^/]+)') + (optional || '') + ')' + (optional || '');
          }).replace(/([\/$\*])/g, '\\$1');
          ret.regexp = new RegExp('^' + path + '$', insensitive ? 'i' : '');
          return ret;
        }
        this.otherwise = function(params) {
          if (typeof params === 'string') {
            params = {redirectTo: params};
          }
          this.when(null, params);
          return this;
        };
        this.$get = ['$rootScope', '$location', '$routeParams', '$q', '$injector', '$templateRequest', '$sce', function($rootScope, $location, $routeParams, $q, $injector, $templateRequest, $sce) {
          var forceReload = false,
              preparedRoute,
              preparedRouteIsUpdateOnly,
              $route = {
                routes: routes,
                reload: function() {
                  forceReload = true;
                  $rootScope.$evalAsync(function() {
                    prepareRoute();
                    commitRoute();
                  });
                },
                updateParams: function(newParams) {
                  if (this.current && this.current.$$route) {
                    newParams = angular.extend({}, this.current.params, newParams);
                    $location.path(interpolate(this.current.$$route.originalPath, newParams));
                    $location.search(newParams);
                  } else {
                    throw $routeMinErr('norout', 'Tried updating route when with no current route');
                  }
                }
              };
          $rootScope.$on('$locationChangeStart', prepareRoute);
          $rootScope.$on('$locationChangeSuccess', commitRoute);
          return $route;
          function switchRouteMatcher(on, route) {
            var keys = route.keys,
                params = {};
            if (!route.regexp)
              return null;
            var m = route.regexp.exec(on);
            if (!m)
              return null;
            for (var i = 1,
                len = m.length; i < len; ++i) {
              var key = keys[i - 1];
              var val = m[i];
              if (key && val) {
                params[key.name] = val;
              }
            }
            return params;
          }
          function prepareRoute($locationEvent) {
            var lastRoute = $route.current;
            preparedRoute = parseRoute();
            preparedRouteIsUpdateOnly = preparedRoute && lastRoute && preparedRoute.$$route === lastRoute.$$route && angular.equals(preparedRoute.pathParams, lastRoute.pathParams) && !preparedRoute.reloadOnSearch && !forceReload;
            if (!preparedRouteIsUpdateOnly && (lastRoute || preparedRoute)) {
              if ($rootScope.$broadcast('$routeChangeStart', preparedRoute, lastRoute).defaultPrevented) {
                if ($locationEvent) {
                  $locationEvent.preventDefault();
                }
              }
            }
          }
          function commitRoute() {
            var lastRoute = $route.current;
            var nextRoute = preparedRoute;
            if (preparedRouteIsUpdateOnly) {
              lastRoute.params = nextRoute.params;
              angular.copy(lastRoute.params, $routeParams);
              $rootScope.$broadcast('$routeUpdate', lastRoute);
            } else if (nextRoute || lastRoute) {
              forceReload = false;
              $route.current = nextRoute;
              if (nextRoute) {
                if (nextRoute.redirectTo) {
                  if (angular.isString(nextRoute.redirectTo)) {
                    $location.path(interpolate(nextRoute.redirectTo, nextRoute.params)).search(nextRoute.params).replace();
                  } else {
                    $location.url(nextRoute.redirectTo(nextRoute.pathParams, $location.path(), $location.search())).replace();
                  }
                }
              }
              $q.when(nextRoute).then(function() {
                if (nextRoute) {
                  var locals = angular.extend({}, nextRoute.resolve),
                      template,
                      templateUrl;
                  angular.forEach(locals, function(value, key) {
                    locals[key] = angular.isString(value) ? $injector.get(value) : $injector.invoke(value, null, null, key);
                  });
                  if (angular.isDefined(template = nextRoute.template)) {
                    if (angular.isFunction(template)) {
                      template = template(nextRoute.params);
                    }
                  } else if (angular.isDefined(templateUrl = nextRoute.templateUrl)) {
                    if (angular.isFunction(templateUrl)) {
                      templateUrl = templateUrl(nextRoute.params);
                    }
                    templateUrl = $sce.getTrustedResourceUrl(templateUrl);
                    if (angular.isDefined(templateUrl)) {
                      nextRoute.loadedTemplateUrl = templateUrl;
                      template = $templateRequest(templateUrl);
                    }
                  }
                  if (angular.isDefined(template)) {
                    locals['$template'] = template;
                  }
                  return $q.all(locals);
                }
              }).then(function(locals) {
                if (nextRoute == $route.current) {
                  if (nextRoute) {
                    nextRoute.locals = locals;
                    angular.copy(nextRoute.params, $routeParams);
                  }
                  $rootScope.$broadcast('$routeChangeSuccess', nextRoute, lastRoute);
                }
              }, function(error) {
                if (nextRoute == $route.current) {
                  $rootScope.$broadcast('$routeChangeError', nextRoute, lastRoute, error);
                }
              });
            }
          }
          function parseRoute() {
            var params,
                match;
            angular.forEach(routes, function(route, path) {
              if (!match && (params = switchRouteMatcher($location.path(), route))) {
                match = inherit(route, {
                  params: angular.extend({}, $location.search(), params),
                  pathParams: params
                });
                match.$$route = route;
              }
            });
            return match || routes[null] && inherit(routes[null], {
              params: {},
              pathParams: {}
            });
          }
          function interpolate(string, params) {
            var result = [];
            angular.forEach((string || '').split(':'), function(segment, i) {
              if (i === 0) {
                result.push(segment);
              } else {
                var segmentMatch = segment.match(/(\w+)(?:[?*])?(.*)/);
                var key = segmentMatch[1];
                result.push(params[key]);
                result.push(segmentMatch[2] || '');
                delete params[key];
              }
            });
            return result.join('');
          }
        }];
      }
      ngRouteModule.provider('$routeParams', $RouteParamsProvider);
      function $RouteParamsProvider() {
        this.$get = function() {
          return {};
        };
      }
      ngRouteModule.directive('ngView', ngViewFactory);
      ngRouteModule.directive('ngView', ngViewFillContentFactory);
      ngViewFactory.$inject = ['$route', '$anchorScroll', '$animate'];
      function ngViewFactory($route, $anchorScroll, $animate) {
        return {
          restrict: 'ECA',
          terminal: true,
          priority: 400,
          transclude: 'element',
          link: function(scope, $element, attr, ctrl, $transclude) {
            var currentScope,
                currentElement,
                previousLeaveAnimation,
                autoScrollExp = attr.autoscroll,
                onloadExp = attr.onload || '';
            scope.$on('$routeChangeSuccess', update);
            update();
            function cleanupLastView() {
              if (previousLeaveAnimation) {
                $animate.cancel(previousLeaveAnimation);
                previousLeaveAnimation = null;
              }
              if (currentScope) {
                currentScope.$destroy();
                currentScope = null;
              }
              if (currentElement) {
                previousLeaveAnimation = $animate.leave(currentElement);
                previousLeaveAnimation.then(function() {
                  previousLeaveAnimation = null;
                });
                currentElement = null;
              }
            }
            function update() {
              var locals = $route.current && $route.current.locals,
                  template = locals && locals.$template;
              if (angular.isDefined(template)) {
                var newScope = scope.$new();
                var current = $route.current;
                var clone = $transclude(newScope, function(clone) {
                  $animate.enter(clone, null, currentElement || $element).then(function onNgViewEnter() {
                    if (angular.isDefined(autoScrollExp) && (!autoScrollExp || scope.$eval(autoScrollExp))) {
                      $anchorScroll();
                    }
                  });
                  cleanupLastView();
                });
                currentElement = clone;
                currentScope = current.scope = newScope;
                currentScope.$emit('$viewContentLoaded');
                currentScope.$eval(onloadExp);
              } else {
                cleanupLastView();
              }
            }
          }
        };
      }
      ngViewFillContentFactory.$inject = ['$compile', '$controller', '$route'];
      function ngViewFillContentFactory($compile, $controller, $route) {
        return {
          restrict: 'ECA',
          priority: -400,
          link: function(scope, $element) {
            var current = $route.current,
                locals = current.locals;
            $element.html(locals.$template);
            var link = $compile($element.contents());
            if (current.controller) {
              locals.$scope = scope;
              var controller = $controller(current.controller, locals);
              if (current.controllerAs) {
                scope[current.controllerAs] = controller;
              }
              $element.data('$ngControllerController', controller);
              $element.children().data('$ngControllerController', controller);
            }
            link(scope);
          }
        };
      }
    })(window, window.angular);
  }).call(System.global);
  return System.get("@@global-helpers").retrieveGlobal(__module.id, false);
});

System.register("github:angular/bower-angular-animate@1.4.1/angular-animate", ["github:angular/bower-angular@1.4.1"], false, function(__require, __exports, __module) {
  System.get("@@global-helpers").prepareGlobal(__module.id, ["github:angular/bower-angular@1.4.1"]);
  (function() {
    "format global";
    "deps angular";
    (function(window, angular, undefined) {
      'use strict';
      var noop = angular.noop;
      var extend = angular.extend;
      var jqLite = angular.element;
      var forEach = angular.forEach;
      var isArray = angular.isArray;
      var isString = angular.isString;
      var isObject = angular.isObject;
      var isUndefined = angular.isUndefined;
      var isDefined = angular.isDefined;
      var isFunction = angular.isFunction;
      var isElement = angular.isElement;
      var ELEMENT_NODE = 1;
      var COMMENT_NODE = 8;
      var NG_ANIMATE_CLASSNAME = 'ng-animate';
      var NG_ANIMATE_CHILDREN_DATA = '$$ngAnimateChildren';
      var isPromiseLike = function(p) {
        return p && p.then ? true : false;
      };
      function assertArg(arg, name, reason) {
        if (!arg) {
          throw ngMinErr('areq', "Argument '{0}' is {1}", (name || '?'), (reason || "required"));
        }
        return arg;
      }
      function mergeClasses(a, b) {
        if (!a && !b)
          return '';
        if (!a)
          return b;
        if (!b)
          return a;
        if (isArray(a))
          a = a.join(' ');
        if (isArray(b))
          b = b.join(' ');
        return a + ' ' + b;
      }
      function packageStyles(options) {
        var styles = {};
        if (options && (options.to || options.from)) {
          styles.to = options.to;
          styles.from = options.from;
        }
        return styles;
      }
      function pendClasses(classes, fix, isPrefix) {
        var className = '';
        classes = isArray(classes) ? classes : classes && isString(classes) && classes.length ? classes.split(/\s+/) : [];
        forEach(classes, function(klass, i) {
          if (klass && klass.length > 0) {
            className += (i > 0) ? ' ' : '';
            className += isPrefix ? fix + klass : klass + fix;
          }
        });
        return className;
      }
      function removeFromArray(arr, val) {
        var index = arr.indexOf(val);
        if (val >= 0) {
          arr.splice(index, 1);
        }
      }
      function stripCommentsFromElement(element) {
        if (element instanceof jqLite) {
          switch (element.length) {
            case 0:
              return [];
              break;
            case 1:
              if (element[0].nodeType === ELEMENT_NODE) {
                return element;
              }
              break;
            default:
              return jqLite(extractElementNode(element));
              break;
          }
        }
        if (element.nodeType === ELEMENT_NODE) {
          return jqLite(element);
        }
      }
      function extractElementNode(element) {
        if (!element[0])
          return element;
        for (var i = 0; i < element.length; i++) {
          var elm = element[i];
          if (elm.nodeType == ELEMENT_NODE) {
            return elm;
          }
        }
      }
      function $$addClass($$jqLite, element, className) {
        forEach(element, function(elm) {
          $$jqLite.addClass(elm, className);
        });
      }
      function $$removeClass($$jqLite, element, className) {
        forEach(element, function(elm) {
          $$jqLite.removeClass(elm, className);
        });
      }
      function applyAnimationClassesFactory($$jqLite) {
        return function(element, options) {
          if (options.addClass) {
            $$addClass($$jqLite, element, options.addClass);
            options.addClass = null;
          }
          if (options.removeClass) {
            $$removeClass($$jqLite, element, options.removeClass);
            options.removeClass = null;
          }
        };
      }
      function prepareAnimationOptions(options) {
        options = options || {};
        if (!options.$$prepared) {
          var domOperation = options.domOperation || noop;
          options.domOperation = function() {
            options.$$domOperationFired = true;
            domOperation();
            domOperation = noop;
          };
          options.$$prepared = true;
        }
        return options;
      }
      function applyAnimationStyles(element, options) {
        applyAnimationFromStyles(element, options);
        applyAnimationToStyles(element, options);
      }
      function applyAnimationFromStyles(element, options) {
        if (options.from) {
          element.css(options.from);
          options.from = null;
        }
      }
      function applyAnimationToStyles(element, options) {
        if (options.to) {
          element.css(options.to);
          options.to = null;
        }
      }
      function mergeAnimationOptions(element, target, newOptions) {
        var toAdd = (target.addClass || '') + ' ' + (newOptions.addClass || '');
        var toRemove = (target.removeClass || '') + ' ' + (newOptions.removeClass || '');
        var classes = resolveElementClasses(element.attr('class'), toAdd, toRemove);
        extend(target, newOptions);
        if (classes.addClass) {
          target.addClass = classes.addClass;
        } else {
          target.addClass = null;
        }
        if (classes.removeClass) {
          target.removeClass = classes.removeClass;
        } else {
          target.removeClass = null;
        }
        return target;
      }
      function resolveElementClasses(existing, toAdd, toRemove) {
        var ADD_CLASS = 1;
        var REMOVE_CLASS = -1;
        var flags = {};
        existing = splitClassesToLookup(existing);
        toAdd = splitClassesToLookup(toAdd);
        forEach(toAdd, function(value, key) {
          flags[key] = ADD_CLASS;
        });
        toRemove = splitClassesToLookup(toRemove);
        forEach(toRemove, function(value, key) {
          flags[key] = flags[key] === ADD_CLASS ? null : REMOVE_CLASS;
        });
        var classes = {
          addClass: '',
          removeClass: ''
        };
        forEach(flags, function(val, klass) {
          var prop,
              allow;
          if (val === ADD_CLASS) {
            prop = 'addClass';
            allow = !existing[klass];
          } else if (val === REMOVE_CLASS) {
            prop = 'removeClass';
            allow = existing[klass];
          }
          if (allow) {
            if (classes[prop].length) {
              classes[prop] += ' ';
            }
            classes[prop] += klass;
          }
        });
        function splitClassesToLookup(classes) {
          if (isString(classes)) {
            classes = classes.split(' ');
          }
          var obj = {};
          forEach(classes, function(klass) {
            if (klass.length) {
              obj[klass] = true;
            }
          });
          return obj;
        }
        return classes;
      }
      function getDomNode(element) {
        return (element instanceof angular.element) ? element[0] : element;
      }
      var $$rAFSchedulerFactory = ['$$rAF', function($$rAF) {
        var tickQueue = [];
        var cancelFn;
        function scheduler(tasks) {
          tickQueue.push([].concat(tasks));
          nextTick();
        }
        scheduler.waitUntilQuiet = function(fn) {
          if (cancelFn)
            cancelFn();
          cancelFn = $$rAF(function() {
            cancelFn = null;
            fn();
            nextTick();
          });
        };
        return scheduler;
        function nextTick() {
          if (!tickQueue.length)
            return ;
          var updatedQueue = [];
          for (var i = 0; i < tickQueue.length; i++) {
            var innerQueue = tickQueue[i];
            runNextTask(innerQueue);
            if (innerQueue.length) {
              updatedQueue.push(innerQueue);
            }
          }
          tickQueue = updatedQueue;
          if (!cancelFn) {
            $$rAF(function() {
              if (!cancelFn)
                nextTick();
            });
          }
        }
        function runNextTask(tasks) {
          var nextTask = tasks.shift();
          nextTask();
        }
      }];
      var $$AnimateChildrenDirective = [function() {
        return function(scope, element, attrs) {
          var val = attrs.ngAnimateChildren;
          if (angular.isString(val) && val.length === 0) {
            element.data(NG_ANIMATE_CHILDREN_DATA, true);
          } else {
            attrs.$observe('ngAnimateChildren', function(value) {
              value = value === 'on' || value === 'true';
              element.data(NG_ANIMATE_CHILDREN_DATA, value);
            });
          }
        };
      }];
      var CSS_PREFIX = '',
          TRANSITION_PROP,
          TRANSITIONEND_EVENT,
          ANIMATION_PROP,
          ANIMATIONEND_EVENT;
      if (window.ontransitionend === undefined && window.onwebkittransitionend !== undefined) {
        CSS_PREFIX = '-webkit-';
        TRANSITION_PROP = 'WebkitTransition';
        TRANSITIONEND_EVENT = 'webkitTransitionEnd transitionend';
      } else {
        TRANSITION_PROP = 'transition';
        TRANSITIONEND_EVENT = 'transitionend';
      }
      if (window.onanimationend === undefined && window.onwebkitanimationend !== undefined) {
        CSS_PREFIX = '-webkit-';
        ANIMATION_PROP = 'WebkitAnimation';
        ANIMATIONEND_EVENT = 'webkitAnimationEnd animationend';
      } else {
        ANIMATION_PROP = 'animation';
        ANIMATIONEND_EVENT = 'animationend';
      }
      var DURATION_KEY = 'Duration';
      var PROPERTY_KEY = 'Property';
      var DELAY_KEY = 'Delay';
      var TIMING_KEY = 'TimingFunction';
      var ANIMATION_ITERATION_COUNT_KEY = 'IterationCount';
      var ANIMATION_PLAYSTATE_KEY = 'PlayState';
      var ELAPSED_TIME_MAX_DECIMAL_PLACES = 3;
      var CLOSING_TIME_BUFFER = 1.5;
      var ONE_SECOND = 1000;
      var BASE_TEN = 10;
      var SAFE_FAST_FORWARD_DURATION_VALUE = 9999;
      var ANIMATION_DELAY_PROP = ANIMATION_PROP + DELAY_KEY;
      var ANIMATION_DURATION_PROP = ANIMATION_PROP + DURATION_KEY;
      var TRANSITION_DELAY_PROP = TRANSITION_PROP + DELAY_KEY;
      var TRANSITION_DURATION_PROP = TRANSITION_PROP + DURATION_KEY;
      var DETECT_CSS_PROPERTIES = {
        transitionDuration: TRANSITION_DURATION_PROP,
        transitionDelay: TRANSITION_DELAY_PROP,
        transitionProperty: TRANSITION_PROP + PROPERTY_KEY,
        animationDuration: ANIMATION_DURATION_PROP,
        animationDelay: ANIMATION_DELAY_PROP,
        animationIterationCount: ANIMATION_PROP + ANIMATION_ITERATION_COUNT_KEY
      };
      var DETECT_STAGGER_CSS_PROPERTIES = {
        transitionDuration: TRANSITION_DURATION_PROP,
        transitionDelay: TRANSITION_DELAY_PROP,
        animationDuration: ANIMATION_DURATION_PROP,
        animationDelay: ANIMATION_DELAY_PROP
      };
      function computeCssStyles($window, element, properties) {
        var styles = Object.create(null);
        var detectedStyles = $window.getComputedStyle(element) || {};
        forEach(properties, function(formalStyleName, actualStyleName) {
          var val = detectedStyles[formalStyleName];
          if (val) {
            var c = val.charAt(0);
            if (c === '-' || c === '+' || c >= 0) {
              val = parseMaxTime(val);
            }
            if (val === 0) {
              val = null;
            }
            styles[actualStyleName] = val;
          }
        });
        return styles;
      }
      function parseMaxTime(str) {
        var maxValue = 0;
        var values = str.split(/\s*,\s*/);
        forEach(values, function(value) {
          if (value.charAt(value.length - 1) == 's') {
            value = value.substring(0, value.length - 1);
          }
          value = parseFloat(value) || 0;
          maxValue = maxValue ? Math.max(value, maxValue) : value;
        });
        return maxValue;
      }
      function truthyTimingValue(val) {
        return val === 0 || val != null;
      }
      function getCssTransitionDurationStyle(duration, applyOnlyDuration) {
        var style = TRANSITION_PROP;
        var value = duration + 's';
        if (applyOnlyDuration) {
          style += DURATION_KEY;
        } else {
          value += ' linear all';
        }
        return [style, value];
      }
      function getCssKeyframeDurationStyle(duration) {
        return [ANIMATION_DURATION_PROP, duration + 's'];
      }
      function getCssDelayStyle(delay, isKeyframeAnimation) {
        var prop = isKeyframeAnimation ? ANIMATION_DELAY_PROP : TRANSITION_DELAY_PROP;
        return [prop, delay + 's'];
      }
      function blockTransitions(node, duration) {
        var value = duration ? '-' + duration + 's' : '';
        applyInlineStyle(node, [TRANSITION_DELAY_PROP, value]);
        return [TRANSITION_DELAY_PROP, value];
      }
      function blockKeyframeAnimations(node, applyBlock) {
        var value = applyBlock ? 'paused' : '';
        var key = ANIMATION_PROP + ANIMATION_PLAYSTATE_KEY;
        applyInlineStyle(node, [key, value]);
        return [key, value];
      }
      function applyInlineStyle(node, styleTuple) {
        var prop = styleTuple[0];
        var value = styleTuple[1];
        node.style[prop] = value;
      }
      function createLocalCacheLookup() {
        var cache = Object.create(null);
        return {
          flush: function() {
            cache = Object.create(null);
          },
          count: function(key) {
            var entry = cache[key];
            return entry ? entry.total : 0;
          },
          get: function(key) {
            var entry = cache[key];
            return entry && entry.value;
          },
          put: function(key, value) {
            if (!cache[key]) {
              cache[key] = {
                total: 1,
                value: value
              };
            } else {
              cache[key].total++;
            }
          }
        };
      }
      var $AnimateCssProvider = ['$animateProvider', function($animateProvider) {
        var gcsLookup = createLocalCacheLookup();
        var gcsStaggerLookup = createLocalCacheLookup();
        this.$get = ['$window', '$$jqLite', '$$AnimateRunner', '$timeout', '$document', '$sniffer', '$$rAFScheduler', function($window, $$jqLite, $$AnimateRunner, $timeout, $document, $sniffer, $$rAFScheduler) {
          var applyAnimationClasses = applyAnimationClassesFactory($$jqLite);
          var parentCounter = 0;
          function gcsHashFn(node, extraClasses) {
            var KEY = "$$ngAnimateParentKey";
            var parentNode = node.parentNode;
            var parentID = parentNode[KEY] || (parentNode[KEY] = ++parentCounter);
            return parentID + '-' + node.getAttribute('class') + '-' + extraClasses;
          }
          function computeCachedCssStyles(node, className, cacheKey, properties) {
            var timings = gcsLookup.get(cacheKey);
            if (!timings) {
              timings = computeCssStyles($window, node, properties);
              if (timings.animationIterationCount === 'infinite') {
                timings.animationIterationCount = 1;
              }
            }
            gcsLookup.put(cacheKey, timings);
            return timings;
          }
          function computeCachedCssStaggerStyles(node, className, cacheKey, properties) {
            var stagger;
            if (gcsLookup.count(cacheKey) > 0) {
              stagger = gcsStaggerLookup.get(cacheKey);
              if (!stagger) {
                var staggerClassName = pendClasses(className, '-stagger');
                $$jqLite.addClass(node, staggerClassName);
                stagger = computeCssStyles($window, node, properties);
                stagger.animationDuration = Math.max(stagger.animationDuration, 0);
                stagger.transitionDuration = Math.max(stagger.transitionDuration, 0);
                $$jqLite.removeClass(node, staggerClassName);
                gcsStaggerLookup.put(cacheKey, stagger);
              }
            }
            return stagger || {};
          }
          var bod = getDomNode($document).body;
          var rafWaitQueue = [];
          function waitUntilQuiet(callback) {
            rafWaitQueue.push(callback);
            $$rAFScheduler.waitUntilQuiet(function() {
              gcsLookup.flush();
              gcsStaggerLookup.flush();
              var width = bod.offsetWidth + 1;
              for (var i = 0; i < rafWaitQueue.length; i++) {
                rafWaitQueue[i](width);
              }
              rafWaitQueue.length = 0;
            });
          }
          return init;
          function computeTimings(node, className, cacheKey) {
            var timings = computeCachedCssStyles(node, className, cacheKey, DETECT_CSS_PROPERTIES);
            var aD = timings.animationDelay;
            var tD = timings.transitionDelay;
            timings.maxDelay = aD && tD ? Math.max(aD, tD) : (aD || tD);
            timings.maxDuration = Math.max(timings.animationDuration * timings.animationIterationCount, timings.transitionDuration);
            return timings;
          }
          function init(element, options) {
            var node = getDomNode(element);
            options = prepareAnimationOptions(options);
            var temporaryStyles = [];
            var classes = element.attr('class');
            var styles = packageStyles(options);
            var animationClosed;
            var animationPaused;
            var animationCompleted;
            var runner;
            var runnerHost;
            var maxDelay;
            var maxDelayTime;
            var maxDuration;
            var maxDurationTime;
            if (options.duration === 0 || (!$sniffer.animations && !$sniffer.transitions)) {
              return closeAndReturnNoopAnimator();
            }
            var method = options.event && isArray(options.event) ? options.event.join(' ') : options.event;
            var isStructural = method && options.structural;
            var structuralClassName = '';
            var addRemoveClassName = '';
            if (isStructural) {
              structuralClassName = pendClasses(method, 'ng-', true);
            } else if (method) {
              structuralClassName = method;
            }
            if (options.addClass) {
              addRemoveClassName += pendClasses(options.addClass, '-add');
            }
            if (options.removeClass) {
              if (addRemoveClassName.length) {
                addRemoveClassName += ' ';
              }
              addRemoveClassName += pendClasses(options.removeClass, '-remove');
            }
            if (options.applyClassesEarly && addRemoveClassName.length) {
              applyAnimationClasses(element, options);
              addRemoveClassName = '';
            }
            var setupClasses = [structuralClassName, addRemoveClassName].join(' ').trim();
            var fullClassName = classes + ' ' + setupClasses;
            var activeClasses = pendClasses(setupClasses, '-active');
            var hasToStyles = styles.to && Object.keys(styles.to).length > 0;
            if (!hasToStyles && !setupClasses) {
              return closeAndReturnNoopAnimator();
            }
            var cacheKey,
                stagger;
            if (options.stagger > 0) {
              var staggerVal = parseFloat(options.stagger);
              stagger = {
                transitionDelay: staggerVal,
                animationDelay: staggerVal,
                transitionDuration: 0,
                animationDuration: 0
              };
            } else {
              cacheKey = gcsHashFn(node, fullClassName);
              stagger = computeCachedCssStaggerStyles(node, setupClasses, cacheKey, DETECT_STAGGER_CSS_PROPERTIES);
            }
            $$jqLite.addClass(element, setupClasses);
            var applyOnlyDuration;
            if (options.transitionStyle) {
              var transitionStyle = [TRANSITION_PROP, options.transitionStyle];
              applyInlineStyle(node, transitionStyle);
              temporaryStyles.push(transitionStyle);
            }
            if (options.duration >= 0) {
              applyOnlyDuration = node.style[TRANSITION_PROP].length > 0;
              var durationStyle = getCssTransitionDurationStyle(options.duration, applyOnlyDuration);
              applyInlineStyle(node, durationStyle);
              temporaryStyles.push(durationStyle);
            }
            if (options.keyframeStyle) {
              var keyframeStyle = [ANIMATION_PROP, options.keyframeStyle];
              applyInlineStyle(node, keyframeStyle);
              temporaryStyles.push(keyframeStyle);
            }
            var itemIndex = stagger ? options.staggerIndex >= 0 ? options.staggerIndex : gcsLookup.count(cacheKey) : 0;
            var isFirst = itemIndex === 0;
            if (isFirst) {
              blockTransitions(node, SAFE_FAST_FORWARD_DURATION_VALUE);
            }
            var timings = computeTimings(node, fullClassName, cacheKey);
            var relativeDelay = timings.maxDelay;
            maxDelay = Math.max(relativeDelay, 0);
            maxDuration = timings.maxDuration;
            var flags = {};
            flags.hasTransitions = timings.transitionDuration > 0;
            flags.hasAnimations = timings.animationDuration > 0;
            flags.hasTransitionAll = flags.hasTransitions && timings.transitionProperty == 'all';
            flags.applyTransitionDuration = hasToStyles && ((flags.hasTransitions && !flags.hasTransitionAll) || (flags.hasAnimations && !flags.hasTransitions));
            flags.applyAnimationDuration = options.duration && flags.hasAnimations;
            flags.applyTransitionDelay = truthyTimingValue(options.delay) && (flags.applyTransitionDuration || flags.hasTransitions);
            flags.applyAnimationDelay = truthyTimingValue(options.delay) && flags.hasAnimations;
            flags.recalculateTimingStyles = addRemoveClassName.length > 0;
            if (flags.applyTransitionDuration || flags.applyAnimationDuration) {
              maxDuration = options.duration ? parseFloat(options.duration) : maxDuration;
              if (flags.applyTransitionDuration) {
                flags.hasTransitions = true;
                timings.transitionDuration = maxDuration;
                applyOnlyDuration = node.style[TRANSITION_PROP + PROPERTY_KEY].length > 0;
                temporaryStyles.push(getCssTransitionDurationStyle(maxDuration, applyOnlyDuration));
              }
              if (flags.applyAnimationDuration) {
                flags.hasAnimations = true;
                timings.animationDuration = maxDuration;
                temporaryStyles.push(getCssKeyframeDurationStyle(maxDuration));
              }
            }
            if (maxDuration === 0 && !flags.recalculateTimingStyles) {
              return closeAndReturnNoopAnimator();
            }
            if (options.duration == null && timings.transitionDuration > 0) {
              flags.recalculateTimingStyles = flags.recalculateTimingStyles || isFirst;
            }
            maxDelayTime = maxDelay * ONE_SECOND;
            maxDurationTime = maxDuration * ONE_SECOND;
            if (!options.skipBlocking) {
              flags.blockTransition = timings.transitionDuration > 0;
              flags.blockKeyframeAnimation = timings.animationDuration > 0 && stagger.animationDelay > 0 && stagger.animationDuration === 0;
            }
            applyAnimationFromStyles(element, options);
            if (!flags.blockTransition) {
              blockTransitions(node, false);
            }
            applyBlocking(maxDuration);
            return {
              $$willAnimate: true,
              end: endFn,
              start: function() {
                if (animationClosed)
                  return ;
                runnerHost = {
                  end: endFn,
                  cancel: cancelFn,
                  resume: null,
                  pause: null
                };
                runner = new $$AnimateRunner(runnerHost);
                waitUntilQuiet(start);
                return runner;
              }
            };
            function endFn() {
              close();
            }
            function cancelFn() {
              close(true);
            }
            function close(rejected) {
              if (animationClosed || (animationCompleted && animationPaused))
                return ;
              animationClosed = true;
              animationPaused = false;
              $$jqLite.removeClass(element, setupClasses);
              $$jqLite.removeClass(element, activeClasses);
              blockKeyframeAnimations(node, false);
              blockTransitions(node, false);
              forEach(temporaryStyles, function(entry) {
                node.style[entry[0]] = '';
              });
              applyAnimationClasses(element, options);
              applyAnimationStyles(element, options);
              if (options.onDone) {
                options.onDone();
              }
              if (runner) {
                runner.complete(!rejected);
              }
            }
            function applyBlocking(duration) {
              if (flags.blockTransition) {
                blockTransitions(node, duration);
              }
              if (flags.blockKeyframeAnimation) {
                blockKeyframeAnimations(node, !!duration);
              }
            }
            function closeAndReturnNoopAnimator() {
              runner = new $$AnimateRunner({
                end: endFn,
                cancel: cancelFn
              });
              close();
              return {
                $$willAnimate: false,
                start: function() {
                  return runner;
                },
                end: endFn
              };
            }
            function start() {
              if (animationClosed)
                return ;
              var startTime,
                  events = [];
              var playPause = function(playAnimation) {
                if (!animationCompleted) {
                  animationPaused = !playAnimation;
                  if (timings.animationDuration) {
                    var value = blockKeyframeAnimations(node, animationPaused);
                    animationPaused ? temporaryStyles.push(value) : removeFromArray(temporaryStyles, value);
                  }
                } else if (animationPaused && playAnimation) {
                  animationPaused = false;
                  close();
                }
              };
              var maxStagger = itemIndex > 0 && ((timings.transitionDuration && stagger.transitionDuration === 0) || (timings.animationDuration && stagger.animationDuration === 0)) && Math.max(stagger.animationDelay, stagger.transitionDelay);
              if (maxStagger) {
                $timeout(triggerAnimationStart, Math.floor(maxStagger * itemIndex * ONE_SECOND), false);
              } else {
                triggerAnimationStart();
              }
              runnerHost.resume = function() {
                playPause(true);
              };
              runnerHost.pause = function() {
                playPause(false);
              };
              function triggerAnimationStart() {
                if (animationClosed)
                  return ;
                applyBlocking(false);
                forEach(temporaryStyles, function(entry) {
                  var key = entry[0];
                  var value = entry[1];
                  node.style[key] = value;
                });
                applyAnimationClasses(element, options);
                $$jqLite.addClass(element, activeClasses);
                if (flags.recalculateTimingStyles) {
                  fullClassName = node.className + ' ' + setupClasses;
                  cacheKey = gcsHashFn(node, fullClassName);
                  timings = computeTimings(node, fullClassName, cacheKey);
                  relativeDelay = timings.maxDelay;
                  maxDelay = Math.max(relativeDelay, 0);
                  maxDuration = timings.maxDuration;
                  if (maxDuration === 0) {
                    close();
                    return ;
                  }
                  flags.hasTransitions = timings.transitionDuration > 0;
                  flags.hasAnimations = timings.animationDuration > 0;
                }
                if (flags.applyTransitionDelay || flags.applyAnimationDelay) {
                  relativeDelay = typeof options.delay !== "boolean" && truthyTimingValue(options.delay) ? parseFloat(options.delay) : relativeDelay;
                  maxDelay = Math.max(relativeDelay, 0);
                  var delayStyle;
                  if (flags.applyTransitionDelay) {
                    timings.transitionDelay = relativeDelay;
                    delayStyle = getCssDelayStyle(relativeDelay);
                    temporaryStyles.push(delayStyle);
                    node.style[delayStyle[0]] = delayStyle[1];
                  }
                  if (flags.applyAnimationDelay) {
                    timings.animationDelay = relativeDelay;
                    delayStyle = getCssDelayStyle(relativeDelay, true);
                    temporaryStyles.push(delayStyle);
                    node.style[delayStyle[0]] = delayStyle[1];
                  }
                }
                maxDelayTime = maxDelay * ONE_SECOND;
                maxDurationTime = maxDuration * ONE_SECOND;
                if (options.easing) {
                  var easeProp,
                      easeVal = options.easing;
                  if (flags.hasTransitions) {
                    easeProp = TRANSITION_PROP + TIMING_KEY;
                    temporaryStyles.push([easeProp, easeVal]);
                    node.style[easeProp] = easeVal;
                  }
                  if (flags.hasAnimations) {
                    easeProp = ANIMATION_PROP + TIMING_KEY;
                    temporaryStyles.push([easeProp, easeVal]);
                    node.style[easeProp] = easeVal;
                  }
                }
                if (timings.transitionDuration) {
                  events.push(TRANSITIONEND_EVENT);
                }
                if (timings.animationDuration) {
                  events.push(ANIMATIONEND_EVENT);
                }
                startTime = Date.now();
                element.on(events.join(' '), onAnimationProgress);
                $timeout(onAnimationExpired, maxDelayTime + CLOSING_TIME_BUFFER * maxDurationTime);
                applyAnimationToStyles(element, options);
              }
              function onAnimationExpired() {
                close();
              }
              function onAnimationProgress(event) {
                event.stopPropagation();
                var ev = event.originalEvent || event;
                var timeStamp = ev.$manualTimeStamp || ev.timeStamp || Date.now();
                var elapsedTime = parseFloat(ev.elapsedTime.toFixed(ELAPSED_TIME_MAX_DECIMAL_PLACES));
                if (Math.max(timeStamp - startTime, 0) >= maxDelayTime && elapsedTime >= maxDuration) {
                  animationCompleted = true;
                  close();
                }
              }
            }
          }
        }];
      }];
      var $$AnimateCssDriverProvider = ['$$animationProvider', function($$animationProvider) {
        $$animationProvider.drivers.push('$$animateCssDriver');
        var NG_ANIMATE_SHIM_CLASS_NAME = 'ng-animate-shim';
        var NG_ANIMATE_ANCHOR_CLASS_NAME = 'ng-anchor';
        var NG_OUT_ANCHOR_CLASS_NAME = 'ng-anchor-out';
        var NG_IN_ANCHOR_CLASS_NAME = 'ng-anchor-in';
        this.$get = ['$animateCss', '$rootScope', '$$AnimateRunner', '$rootElement', '$document', '$sniffer', function($animateCss, $rootScope, $$AnimateRunner, $rootElement, $document, $sniffer) {
          if (!$sniffer.animations && !$sniffer.transitions)
            return noop;
          var bodyNode = getDomNode($document).body;
          var rootNode = getDomNode($rootElement);
          var rootBodyElement = jqLite(bodyNode.parentNode === rootNode ? bodyNode : rootNode);
          return function initDriverFn(animationDetails) {
            return animationDetails.from && animationDetails.to ? prepareFromToAnchorAnimation(animationDetails.from, animationDetails.to, animationDetails.classes, animationDetails.anchors) : prepareRegularAnimation(animationDetails);
          };
          function filterCssClasses(classes) {
            return classes.replace(/\bng-\S+\b/g, '');
          }
          function getUniqueValues(a, b) {
            if (isString(a))
              a = a.split(' ');
            if (isString(b))
              b = b.split(' ');
            return a.filter(function(val) {
              return b.indexOf(val) === -1;
            }).join(' ');
          }
          function prepareAnchoredAnimation(classes, outAnchor, inAnchor) {
            var clone = jqLite(getDomNode(outAnchor).cloneNode(true));
            var startingClasses = filterCssClasses(getClassVal(clone));
            outAnchor.addClass(NG_ANIMATE_SHIM_CLASS_NAME);
            inAnchor.addClass(NG_ANIMATE_SHIM_CLASS_NAME);
            clone.addClass(NG_ANIMATE_ANCHOR_CLASS_NAME);
            rootBodyElement.append(clone);
            var animatorIn,
                animatorOut = prepareOutAnimation();
            if (!animatorOut) {
              animatorIn = prepareInAnimation();
              if (!animatorIn) {
                return end();
              }
            }
            var startingAnimator = animatorOut || animatorIn;
            return {start: function() {
                var runner;
                var currentAnimation = startingAnimator.start();
                currentAnimation.done(function() {
                  currentAnimation = null;
                  if (!animatorIn) {
                    animatorIn = prepareInAnimation();
                    if (animatorIn) {
                      currentAnimation = animatorIn.start();
                      currentAnimation.done(function() {
                        currentAnimation = null;
                        end();
                        runner.complete();
                      });
                      return currentAnimation;
                    }
                  }
                  end();
                  runner.complete();
                });
                runner = new $$AnimateRunner({
                  end: endFn,
                  cancel: endFn
                });
                return runner;
                function endFn() {
                  if (currentAnimation) {
                    currentAnimation.end();
                  }
                }
              }};
            function calculateAnchorStyles(anchor) {
              var styles = {};
              var coords = getDomNode(anchor).getBoundingClientRect();
              forEach(['width', 'height', 'top', 'left'], function(key) {
                var value = coords[key];
                switch (key) {
                  case 'top':
                    value += bodyNode.scrollTop;
                    break;
                  case 'left':
                    value += bodyNode.scrollLeft;
                    break;
                }
                styles[key] = Math.floor(value) + 'px';
              });
              return styles;
            }
            function prepareOutAnimation() {
              var animator = $animateCss(clone, {
                addClass: NG_OUT_ANCHOR_CLASS_NAME,
                delay: true,
                from: calculateAnchorStyles(outAnchor)
              });
              return animator.$$willAnimate ? animator : null;
            }
            function getClassVal(element) {
              return element.attr('class') || '';
            }
            function prepareInAnimation() {
              var endingClasses = filterCssClasses(getClassVal(inAnchor));
              var toAdd = getUniqueValues(endingClasses, startingClasses);
              var toRemove = getUniqueValues(startingClasses, endingClasses);
              var animator = $animateCss(clone, {
                to: calculateAnchorStyles(inAnchor),
                addClass: NG_IN_ANCHOR_CLASS_NAME + ' ' + toAdd,
                removeClass: NG_OUT_ANCHOR_CLASS_NAME + ' ' + toRemove,
                delay: true
              });
              return animator.$$willAnimate ? animator : null;
            }
            function end() {
              clone.remove();
              outAnchor.removeClass(NG_ANIMATE_SHIM_CLASS_NAME);
              inAnchor.removeClass(NG_ANIMATE_SHIM_CLASS_NAME);
            }
          }
          function prepareFromToAnchorAnimation(from, to, classes, anchors) {
            var fromAnimation = prepareRegularAnimation(from);
            var toAnimation = prepareRegularAnimation(to);
            var anchorAnimations = [];
            forEach(anchors, function(anchor) {
              var outElement = anchor['out'];
              var inElement = anchor['in'];
              var animator = prepareAnchoredAnimation(classes, outElement, inElement);
              if (animator) {
                anchorAnimations.push(animator);
              }
            });
            if (!fromAnimation && !toAnimation && anchorAnimations.length === 0)
              return ;
            return {start: function() {
                var animationRunners = [];
                if (fromAnimation) {
                  animationRunners.push(fromAnimation.start());
                }
                if (toAnimation) {
                  animationRunners.push(toAnimation.start());
                }
                forEach(anchorAnimations, function(animation) {
                  animationRunners.push(animation.start());
                });
                var runner = new $$AnimateRunner({
                  end: endFn,
                  cancel: endFn
                });
                $$AnimateRunner.all(animationRunners, function(status) {
                  runner.complete(status);
                });
                return runner;
                function endFn() {
                  forEach(animationRunners, function(runner) {
                    runner.end();
                  });
                }
              }};
          }
          function prepareRegularAnimation(animationDetails) {
            var element = animationDetails.element;
            var options = animationDetails.options || {};
            if (animationDetails.structural) {
              options.structural = options.applyClassesEarly = true;
              options.event = animationDetails.event;
              if (options.event === 'leave') {
                options.onDone = options.domOperation;
              }
            } else {
              options.event = null;
            }
            var animator = $animateCss(element, options);
            return animator.$$willAnimate ? animator : null;
          }
        }];
      }];
      var $$AnimateJsProvider = ['$animateProvider', function($animateProvider) {
        this.$get = ['$injector', '$$AnimateRunner', '$$rAFMutex', '$$jqLite', function($injector, $$AnimateRunner, $$rAFMutex, $$jqLite) {
          var applyAnimationClasses = applyAnimationClassesFactory($$jqLite);
          return function(element, event, classes, options) {
            if (arguments.length === 3 && isObject(classes)) {
              options = classes;
              classes = null;
            }
            options = prepareAnimationOptions(options);
            if (!classes) {
              classes = element.attr('class') || '';
              if (options.addClass) {
                classes += ' ' + options.addClass;
              }
              if (options.removeClass) {
                classes += ' ' + options.removeClass;
              }
            }
            var classesToAdd = options.addClass;
            var classesToRemove = options.removeClass;
            var animations = lookupAnimations(classes);
            var before,
                after;
            if (animations.length) {
              var afterFn,
                  beforeFn;
              if (event == 'leave') {
                beforeFn = 'leave';
                afterFn = 'afterLeave';
              } else {
                beforeFn = 'before' + event.charAt(0).toUpperCase() + event.substr(1);
                afterFn = event;
              }
              if (event !== 'enter' && event !== 'move') {
                before = packageAnimations(element, event, options, animations, beforeFn);
              }
              after = packageAnimations(element, event, options, animations, afterFn);
            }
            if (!before && !after)
              return ;
            function applyOptions() {
              options.domOperation();
              applyAnimationClasses(element, options);
            }
            return {start: function() {
                var closeActiveAnimations;
                var chain = [];
                if (before) {
                  chain.push(function(fn) {
                    closeActiveAnimations = before(fn);
                  });
                }
                if (chain.length) {
                  chain.push(function(fn) {
                    applyOptions();
                    fn(true);
                  });
                } else {
                  applyOptions();
                }
                if (after) {
                  chain.push(function(fn) {
                    closeActiveAnimations = after(fn);
                  });
                }
                var animationClosed = false;
                var runner = new $$AnimateRunner({
                  end: function() {
                    endAnimations();
                  },
                  cancel: function() {
                    endAnimations(true);
                  }
                });
                $$AnimateRunner.chain(chain, onComplete);
                return runner;
                function onComplete(success) {
                  animationClosed = true;
                  applyOptions();
                  applyAnimationStyles(element, options);
                  runner.complete(success);
                }
                function endAnimations(cancelled) {
                  if (!animationClosed) {
                    (closeActiveAnimations || noop)(cancelled);
                    onComplete(cancelled);
                  }
                }
              }};
            function executeAnimationFn(fn, element, event, options, onDone) {
              var args;
              switch (event) {
                case 'animate':
                  args = [element, options.from, options.to, onDone];
                  break;
                case 'setClass':
                  args = [element, classesToAdd, classesToRemove, onDone];
                  break;
                case 'addClass':
                  args = [element, classesToAdd, onDone];
                  break;
                case 'removeClass':
                  args = [element, classesToRemove, onDone];
                  break;
                default:
                  args = [element, onDone];
                  break;
              }
              args.push(options);
              var value = fn.apply(fn, args);
              if (value) {
                if (isFunction(value.start)) {
                  value = value.start();
                }
                if (value instanceof $$AnimateRunner) {
                  value.done(onDone);
                } else if (isFunction(value)) {
                  return value;
                }
              }
              return noop;
            }
            function groupEventedAnimations(element, event, options, animations, fnName) {
              var operations = [];
              forEach(animations, function(ani) {
                var animation = ani[fnName];
                if (!animation)
                  return ;
                operations.push(function() {
                  var runner;
                  var endProgressCb;
                  var resolved = false;
                  var onAnimationComplete = function(rejected) {
                    if (!resolved) {
                      resolved = true;
                      (endProgressCb || noop)(rejected);
                      runner.complete(!rejected);
                    }
                  };
                  runner = new $$AnimateRunner({
                    end: function() {
                      onAnimationComplete();
                    },
                    cancel: function() {
                      onAnimationComplete(true);
                    }
                  });
                  endProgressCb = executeAnimationFn(animation, element, event, options, function(result) {
                    var cancelled = result === false;
                    onAnimationComplete(cancelled);
                  });
                  return runner;
                });
              });
              return operations;
            }
            function packageAnimations(element, event, options, animations, fnName) {
              var operations = groupEventedAnimations(element, event, options, animations, fnName);
              if (operations.length === 0) {
                var a,
                    b;
                if (fnName === 'beforeSetClass') {
                  a = groupEventedAnimations(element, 'removeClass', options, animations, 'beforeRemoveClass');
                  b = groupEventedAnimations(element, 'addClass', options, animations, 'beforeAddClass');
                } else if (fnName === 'setClass') {
                  a = groupEventedAnimations(element, 'removeClass', options, animations, 'removeClass');
                  b = groupEventedAnimations(element, 'addClass', options, animations, 'addClass');
                }
                if (a) {
                  operations = operations.concat(a);
                }
                if (b) {
                  operations = operations.concat(b);
                }
              }
              if (operations.length === 0)
                return ;
              return function startAnimation(callback) {
                var runners = [];
                if (operations.length) {
                  forEach(operations, function(animateFn) {
                    runners.push(animateFn());
                  });
                }
                runners.length ? $$AnimateRunner.all(runners, callback) : callback();
                return function endFn(reject) {
                  forEach(runners, function(runner) {
                    reject ? runner.cancel() : runner.end();
                  });
                };
              };
            }
          };
          function lookupAnimations(classes) {
            classes = isArray(classes) ? classes : classes.split(' ');
            var matches = [],
                flagMap = {};
            for (var i = 0; i < classes.length; i++) {
              var klass = classes[i],
                  animationFactory = $animateProvider.$$registeredAnimations[klass];
              if (animationFactory && !flagMap[klass]) {
                matches.push($injector.get(animationFactory));
                flagMap[klass] = true;
              }
            }
            return matches;
          }
        }];
      }];
      var $$AnimateJsDriverProvider = ['$$animationProvider', function($$animationProvider) {
        $$animationProvider.drivers.push('$$animateJsDriver');
        this.$get = ['$$animateJs', '$$AnimateRunner', function($$animateJs, $$AnimateRunner) {
          return function initDriverFn(animationDetails) {
            if (animationDetails.from && animationDetails.to) {
              var fromAnimation = prepareAnimation(animationDetails.from);
              var toAnimation = prepareAnimation(animationDetails.to);
              if (!fromAnimation && !toAnimation)
                return ;
              return {start: function() {
                  var animationRunners = [];
                  if (fromAnimation) {
                    animationRunners.push(fromAnimation.start());
                  }
                  if (toAnimation) {
                    animationRunners.push(toAnimation.start());
                  }
                  $$AnimateRunner.all(animationRunners, done);
                  var runner = new $$AnimateRunner({
                    end: endFnFactory(),
                    cancel: endFnFactory()
                  });
                  return runner;
                  function endFnFactory() {
                    return function() {
                      forEach(animationRunners, function(runner) {
                        runner.end();
                      });
                    };
                  }
                  function done(status) {
                    runner.complete(status);
                  }
                }};
            } else {
              return prepareAnimation(animationDetails);
            }
          };
          function prepareAnimation(animationDetails) {
            var element = animationDetails.element;
            var event = animationDetails.event;
            var options = animationDetails.options;
            var classes = animationDetails.classes;
            return $$animateJs(element, event, classes, options);
          }
        }];
      }];
      var NG_ANIMATE_ATTR_NAME = 'data-ng-animate';
      var NG_ANIMATE_PIN_DATA = '$ngAnimatePin';
      var $$AnimateQueueProvider = ['$animateProvider', function($animateProvider) {
        var PRE_DIGEST_STATE = 1;
        var RUNNING_STATE = 2;
        var rules = this.rules = {
          skip: [],
          cancel: [],
          join: []
        };
        function isAllowed(ruleType, element, currentAnimation, previousAnimation) {
          return rules[ruleType].some(function(fn) {
            return fn(element, currentAnimation, previousAnimation);
          });
        }
        function hasAnimationClasses(options, and) {
          options = options || {};
          var a = (options.addClass || '').length > 0;
          var b = (options.removeClass || '').length > 0;
          return and ? a && b : a || b;
        }
        rules.join.push(function(element, newAnimation, currentAnimation) {
          return !newAnimation.structural && hasAnimationClasses(newAnimation.options);
        });
        rules.skip.push(function(element, newAnimation, currentAnimation) {
          return !newAnimation.structural && !hasAnimationClasses(newAnimation.options);
        });
        rules.skip.push(function(element, newAnimation, currentAnimation) {
          return currentAnimation.event == 'leave' && newAnimation.structural;
        });
        rules.skip.push(function(element, newAnimation, currentAnimation) {
          return currentAnimation.structural && !newAnimation.structural;
        });
        rules.cancel.push(function(element, newAnimation, currentAnimation) {
          return currentAnimation.structural && newAnimation.structural;
        });
        rules.cancel.push(function(element, newAnimation, currentAnimation) {
          return currentAnimation.state === RUNNING_STATE && newAnimation.structural;
        });
        rules.cancel.push(function(element, newAnimation, currentAnimation) {
          var nO = newAnimation.options;
          var cO = currentAnimation.options;
          return (nO.addClass && nO.addClass === cO.removeClass) || (nO.removeClass && nO.removeClass === cO.addClass);
        });
        this.$get = ['$$rAF', '$rootScope', '$rootElement', '$document', '$$HashMap', '$$animation', '$$AnimateRunner', '$templateRequest', '$$jqLite', function($$rAF, $rootScope, $rootElement, $document, $$HashMap, $$animation, $$AnimateRunner, $templateRequest, $$jqLite) {
          var activeAnimationsLookup = new $$HashMap();
          var disabledElementsLookup = new $$HashMap();
          var animationsEnabled = null;
          var deregisterWatch = $rootScope.$watch(function() {
            return $templateRequest.totalPendingRequests === 0;
          }, function(isEmpty) {
            if (!isEmpty)
              return ;
            deregisterWatch();
            $rootScope.$$postDigest(function() {
              $rootScope.$$postDigest(function() {
                if (animationsEnabled === null) {
                  animationsEnabled = true;
                }
              });
            });
          });
          var bodyElement = jqLite($document[0].body);
          var callbackRegistry = {};
          var classNameFilter = $animateProvider.classNameFilter();
          var isAnimatableClassName = !classNameFilter ? function() {
            return true;
          } : function(className) {
            return classNameFilter.test(className);
          };
          var applyAnimationClasses = applyAnimationClassesFactory($$jqLite);
          function normalizeAnimationOptions(element, options) {
            return mergeAnimationOptions(element, options, {});
          }
          function findCallbacks(element, event) {
            var targetNode = getDomNode(element);
            var matches = [];
            var entries = callbackRegistry[event];
            if (entries) {
              forEach(entries, function(entry) {
                if (entry.node.contains(targetNode)) {
                  matches.push(entry.callback);
                }
              });
            }
            return matches;
          }
          function triggerCallback(event, element, phase, data) {
            $$rAF(function() {
              forEach(findCallbacks(element, event), function(callback) {
                callback(element, phase, data);
              });
            });
          }
          return {
            on: function(event, container, callback) {
              var node = extractElementNode(container);
              callbackRegistry[event] = callbackRegistry[event] || [];
              callbackRegistry[event].push({
                node: node,
                callback: callback
              });
            },
            off: function(event, container, callback) {
              var entries = callbackRegistry[event];
              if (!entries)
                return ;
              callbackRegistry[event] = arguments.length === 1 ? null : filterFromRegistry(entries, container, callback);
              function filterFromRegistry(list, matchContainer, matchCallback) {
                var containerNode = extractElementNode(matchContainer);
                return list.filter(function(entry) {
                  var isMatch = entry.node === containerNode && (!matchCallback || entry.callback === matchCallback);
                  return !isMatch;
                });
              }
            },
            pin: function(element, parentElement) {
              assertArg(isElement(element), 'element', 'not an element');
              assertArg(isElement(parentElement), 'parentElement', 'not an element');
              element.data(NG_ANIMATE_PIN_DATA, parentElement);
            },
            push: function(element, event, options, domOperation) {
              options = options || {};
              options.domOperation = domOperation;
              return queueAnimation(element, event, options);
            },
            enabled: function(element, bool) {
              var argCount = arguments.length;
              if (argCount === 0) {
                bool = !!animationsEnabled;
              } else {
                var hasElement = isElement(element);
                if (!hasElement) {
                  bool = animationsEnabled = !!element;
                } else {
                  var node = getDomNode(element);
                  var recordExists = disabledElementsLookup.get(node);
                  if (argCount === 1) {
                    bool = !recordExists;
                  } else {
                    bool = !!bool;
                    if (!bool) {
                      disabledElementsLookup.put(node, true);
                    } else if (recordExists) {
                      disabledElementsLookup.remove(node);
                    }
                  }
                }
              }
              return bool;
            }
          };
          function queueAnimation(element, event, options) {
            var node,
                parent;
            element = stripCommentsFromElement(element);
            if (element) {
              node = getDomNode(element);
              parent = element.parent();
            }
            options = prepareAnimationOptions(options);
            var runner = new $$AnimateRunner();
            if (!node) {
              close();
              return runner;
            }
            if (isArray(options.addClass)) {
              options.addClass = options.addClass.join(' ');
            }
            if (isArray(options.removeClass)) {
              options.removeClass = options.removeClass.join(' ');
            }
            if (options.from && !isObject(options.from)) {
              options.from = null;
            }
            if (options.to && !isObject(options.to)) {
              options.to = null;
            }
            var className = [node.className, options.addClass, options.removeClass].join(' ');
            if (!isAnimatableClassName(className)) {
              close();
              return runner;
            }
            var isStructural = ['enter', 'move', 'leave'].indexOf(event) >= 0;
            var skipAnimations = !animationsEnabled || disabledElementsLookup.get(node);
            var existingAnimation = (!skipAnimations && activeAnimationsLookup.get(node)) || {};
            var hasExistingAnimation = !!existingAnimation.state;
            if (!skipAnimations && (!hasExistingAnimation || existingAnimation.state != PRE_DIGEST_STATE)) {
              skipAnimations = !areAnimationsAllowed(element, parent, event);
            }
            if (skipAnimations) {
              close();
              return runner;
            }
            if (isStructural) {
              closeChildAnimations(element);
            }
            var newAnimation = {
              structural: isStructural,
              element: element,
              event: event,
              close: close,
              options: options,
              runner: runner
            };
            if (hasExistingAnimation) {
              var skipAnimationFlag = isAllowed('skip', element, newAnimation, existingAnimation);
              if (skipAnimationFlag) {
                if (existingAnimation.state === RUNNING_STATE) {
                  close();
                  return runner;
                } else {
                  mergeAnimationOptions(element, existingAnimation.options, options);
                  return existingAnimation.runner;
                }
              }
              var cancelAnimationFlag = isAllowed('cancel', element, newAnimation, existingAnimation);
              if (cancelAnimationFlag) {
                if (existingAnimation.state === RUNNING_STATE) {
                  existingAnimation.runner.end();
                } else if (existingAnimation.structural) {
                  existingAnimation.close();
                } else {
                  mergeAnimationOptions(element, newAnimation.options, existingAnimation.options);
                }
              } else {
                var joinAnimationFlag = isAllowed('join', element, newAnimation, existingAnimation);
                if (joinAnimationFlag) {
                  if (existingAnimation.state === RUNNING_STATE) {
                    normalizeAnimationOptions(element, options);
                  } else {
                    event = newAnimation.event = existingAnimation.event;
                    options = mergeAnimationOptions(element, existingAnimation.options, newAnimation.options);
                    return runner;
                  }
                }
              }
            } else {
              normalizeAnimationOptions(element, options);
            }
            var isValidAnimation = newAnimation.structural;
            if (!isValidAnimation) {
              isValidAnimation = (newAnimation.event === 'animate' && Object.keys(newAnimation.options.to || {}).length > 0) || hasAnimationClasses(newAnimation.options);
            }
            if (!isValidAnimation) {
              close();
              clearElementAnimationState(element);
              return runner;
            }
            if (isStructural) {
              closeParentClassBasedAnimations(parent);
            }
            var counter = (existingAnimation.counter || 0) + 1;
            newAnimation.counter = counter;
            markElementAnimationState(element, PRE_DIGEST_STATE, newAnimation);
            $rootScope.$$postDigest(function() {
              var animationDetails = activeAnimationsLookup.get(node);
              var animationCancelled = !animationDetails;
              animationDetails = animationDetails || {};
              var parentElement = element.parent() || [];
              var isValidAnimation = parentElement.length > 0 && (animationDetails.event === 'animate' || animationDetails.structural || hasAnimationClasses(animationDetails.options));
              if (animationCancelled || animationDetails.counter !== counter || !isValidAnimation) {
                if (animationCancelled) {
                  applyAnimationClasses(element, options);
                  applyAnimationStyles(element, options);
                }
                if (animationCancelled || (isStructural && animationDetails.event !== event)) {
                  options.domOperation();
                  runner.end();
                }
                if (!isValidAnimation) {
                  clearElementAnimationState(element);
                }
                return ;
              }
              event = !animationDetails.structural && hasAnimationClasses(animationDetails.options, true) ? 'setClass' : animationDetails.event;
              if (animationDetails.structural) {
                closeParentClassBasedAnimations(parentElement);
              }
              markElementAnimationState(element, RUNNING_STATE);
              var realRunner = $$animation(element, event, animationDetails.options);
              realRunner.done(function(status) {
                close(!status);
                var animationDetails = activeAnimationsLookup.get(node);
                if (animationDetails && animationDetails.counter === counter) {
                  clearElementAnimationState(getDomNode(element));
                }
                notifyProgress(runner, event, 'close', {});
              });
              runner.setHost(realRunner);
              notifyProgress(runner, event, 'start', {});
            });
            return runner;
            function notifyProgress(runner, event, phase, data) {
              triggerCallback(event, element, phase, data);
              runner.progress(event, phase, data);
            }
            function close(reject) {
              applyAnimationClasses(element, options);
              applyAnimationStyles(element, options);
              options.domOperation();
              runner.complete(!reject);
            }
          }
          function closeChildAnimations(element) {
            var node = getDomNode(element);
            var children = node.querySelectorAll('[' + NG_ANIMATE_ATTR_NAME + ']');
            forEach(children, function(child) {
              var state = parseInt(child.getAttribute(NG_ANIMATE_ATTR_NAME));
              var animationDetails = activeAnimationsLookup.get(child);
              switch (state) {
                case RUNNING_STATE:
                  animationDetails.runner.end();
                case PRE_DIGEST_STATE:
                  if (animationDetails) {
                    activeAnimationsLookup.remove(child);
                  }
                  break;
              }
            });
          }
          function clearElementAnimationState(element) {
            var node = getDomNode(element);
            node.removeAttribute(NG_ANIMATE_ATTR_NAME);
            activeAnimationsLookup.remove(node);
          }
          function isMatchingElement(nodeOrElmA, nodeOrElmB) {
            return getDomNode(nodeOrElmA) === getDomNode(nodeOrElmB);
          }
          function closeParentClassBasedAnimations(startingElement) {
            var parentNode = getDomNode(startingElement);
            do {
              if (!parentNode || parentNode.nodeType !== ELEMENT_NODE)
                break;
              var animationDetails = activeAnimationsLookup.get(parentNode);
              if (animationDetails) {
                examineParentAnimation(parentNode, animationDetails);
              }
              parentNode = parentNode.parentNode;
            } while (true);
            function examineParentAnimation(node, animationDetails) {
              if (animationDetails.structural || !hasAnimationClasses(animationDetails.options))
                return ;
              if (animationDetails.state === RUNNING_STATE) {
                animationDetails.runner.end();
              }
              clearElementAnimationState(node);
            }
          }
          function areAnimationsAllowed(element, parentElement, event) {
            var bodyElementDetected = false;
            var rootElementDetected = false;
            var parentAnimationDetected = false;
            var animateChildren;
            var parentHost = element.data(NG_ANIMATE_PIN_DATA);
            if (parentHost) {
              parentElement = parentHost;
            }
            while (parentElement && parentElement.length) {
              if (!rootElementDetected) {
                rootElementDetected = isMatchingElement(parentElement, $rootElement);
              }
              var parentNode = parentElement[0];
              if (parentNode.nodeType !== ELEMENT_NODE) {
                break;
              }
              var details = activeAnimationsLookup.get(parentNode) || {};
              if (!parentAnimationDetected) {
                parentAnimationDetected = details.structural || disabledElementsLookup.get(parentNode);
              }
              if (isUndefined(animateChildren) || animateChildren === true) {
                var value = parentElement.data(NG_ANIMATE_CHILDREN_DATA);
                if (isDefined(value)) {
                  animateChildren = value;
                }
              }
              if (parentAnimationDetected && animateChildren === false)
                break;
              if (!rootElementDetected) {
                rootElementDetected = isMatchingElement(parentElement, $rootElement);
                if (!rootElementDetected) {
                  parentHost = parentElement.data(NG_ANIMATE_PIN_DATA);
                  if (parentHost) {
                    parentElement = parentHost;
                  }
                }
              }
              if (!bodyElementDetected) {
                bodyElementDetected = isMatchingElement(parentElement, bodyElement);
              }
              parentElement = parentElement.parent();
            }
            var allowAnimation = !parentAnimationDetected || animateChildren;
            return allowAnimation && rootElementDetected && bodyElementDetected;
          }
          function markElementAnimationState(element, state, details) {
            details = details || {};
            details.state = state;
            var node = getDomNode(element);
            node.setAttribute(NG_ANIMATE_ATTR_NAME, state);
            var oldValue = activeAnimationsLookup.get(node);
            var newValue = oldValue ? extend(oldValue, details) : details;
            activeAnimationsLookup.put(node, newValue);
          }
        }];
      }];
      var $$rAFMutexFactory = ['$$rAF', function($$rAF) {
        return function() {
          var passed = false;
          $$rAF(function() {
            passed = true;
          });
          return function(fn) {
            passed ? fn() : $$rAF(fn);
          };
        };
      }];
      var $$AnimateRunnerFactory = ['$q', '$$rAFMutex', function($q, $$rAFMutex) {
        var INITIAL_STATE = 0;
        var DONE_PENDING_STATE = 1;
        var DONE_COMPLETE_STATE = 2;
        AnimateRunner.chain = function(chain, callback) {
          var index = 0;
          next();
          function next() {
            if (index === chain.length) {
              callback(true);
              return ;
            }
            chain[index](function(response) {
              if (response === false) {
                callback(false);
                return ;
              }
              index++;
              next();
            });
          }
        };
        AnimateRunner.all = function(runners, callback) {
          var count = 0;
          var status = true;
          forEach(runners, function(runner) {
            runner.done(onProgress);
          });
          function onProgress(response) {
            status = status && response;
            if (++count === runners.length) {
              callback(status);
            }
          }
        };
        function AnimateRunner(host) {
          this.setHost(host);
          this._doneCallbacks = [];
          this._runInAnimationFrame = $$rAFMutex();
          this._state = 0;
        }
        AnimateRunner.prototype = {
          setHost: function(host) {
            this.host = host || {};
          },
          done: function(fn) {
            if (this._state === DONE_COMPLETE_STATE) {
              fn();
            } else {
              this._doneCallbacks.push(fn);
            }
          },
          progress: noop,
          getPromise: function() {
            if (!this.promise) {
              var self = this;
              this.promise = $q(function(resolve, reject) {
                self.done(function(status) {
                  status === false ? reject() : resolve();
                });
              });
            }
            return this.promise;
          },
          then: function(resolveHandler, rejectHandler) {
            return this.getPromise().then(resolveHandler, rejectHandler);
          },
          'catch': function(handler) {
            return this.getPromise()['catch'](handler);
          },
          'finally': function(handler) {
            return this.getPromise()['finally'](handler);
          },
          pause: function() {
            if (this.host.pause) {
              this.host.pause();
            }
          },
          resume: function() {
            if (this.host.resume) {
              this.host.resume();
            }
          },
          end: function() {
            if (this.host.end) {
              this.host.end();
            }
            this._resolve(true);
          },
          cancel: function() {
            if (this.host.cancel) {
              this.host.cancel();
            }
            this._resolve(false);
          },
          complete: function(response) {
            var self = this;
            if (self._state === INITIAL_STATE) {
              self._state = DONE_PENDING_STATE;
              self._runInAnimationFrame(function() {
                self._resolve(response);
              });
            }
          },
          _resolve: function(response) {
            if (this._state !== DONE_COMPLETE_STATE) {
              forEach(this._doneCallbacks, function(fn) {
                fn(response);
              });
              this._doneCallbacks.length = 0;
              this._state = DONE_COMPLETE_STATE;
            }
          }
        };
        return AnimateRunner;
      }];
      var $$AnimationProvider = ['$animateProvider', function($animateProvider) {
        var NG_ANIMATE_REF_ATTR = 'ng-animate-ref';
        var drivers = this.drivers = [];
        var RUNNER_STORAGE_KEY = '$$animationRunner';
        function setRunner(element, runner) {
          element.data(RUNNER_STORAGE_KEY, runner);
        }
        function removeRunner(element) {
          element.removeData(RUNNER_STORAGE_KEY);
        }
        function getRunner(element) {
          return element.data(RUNNER_STORAGE_KEY);
        }
        this.$get = ['$$jqLite', '$rootScope', '$injector', '$$AnimateRunner', '$$rAFScheduler', function($$jqLite, $rootScope, $injector, $$AnimateRunner, $$rAFScheduler) {
          var animationQueue = [];
          var applyAnimationClasses = applyAnimationClassesFactory($$jqLite);
          var totalPendingClassBasedAnimations = 0;
          var totalActiveClassBasedAnimations = 0;
          var classBasedAnimationsQueue = [];
          return function(element, event, options) {
            options = prepareAnimationOptions(options);
            var isStructural = ['enter', 'move', 'leave'].indexOf(event) >= 0;
            var runner = new $$AnimateRunner({
              end: function() {
                close();
              },
              cancel: function() {
                close(true);
              }
            });
            if (!drivers.length) {
              close();
              return runner;
            }
            setRunner(element, runner);
            var classes = mergeClasses(element.attr('class'), mergeClasses(options.addClass, options.removeClass));
            var tempClasses = options.tempClasses;
            if (tempClasses) {
              classes += ' ' + tempClasses;
              options.tempClasses = null;
            }
            var classBasedIndex;
            if (!isStructural) {
              classBasedIndex = totalPendingClassBasedAnimations;
              totalPendingClassBasedAnimations += 1;
            }
            animationQueue.push({
              element: element,
              classes: classes,
              event: event,
              classBasedIndex: classBasedIndex,
              structural: isStructural,
              options: options,
              beforeStart: beforeStart,
              close: close
            });
            element.on('$destroy', handleDestroyedElement);
            if (animationQueue.length > 1)
              return runner;
            $rootScope.$$postDigest(function() {
              totalActiveClassBasedAnimations = totalPendingClassBasedAnimations;
              totalPendingClassBasedAnimations = 0;
              classBasedAnimationsQueue.length = 0;
              var animations = [];
              forEach(animationQueue, function(entry) {
                if (getRunner(entry.element)) {
                  animations.push(entry);
                }
              });
              animationQueue.length = 0;
              forEach(groupAnimations(animations), function(animationEntry) {
                if (animationEntry.structural) {
                  triggerAnimationStart();
                } else {
                  classBasedAnimationsQueue.push({
                    node: getDomNode(animationEntry.element),
                    fn: triggerAnimationStart
                  });
                  if (animationEntry.classBasedIndex === totalActiveClassBasedAnimations - 1) {
                    classBasedAnimationsQueue = classBasedAnimationsQueue.sort(function(a, b) {
                      return b.node.contains(a.node);
                    }).map(function(entry) {
                      return entry.fn;
                    });
                    $$rAFScheduler(classBasedAnimationsQueue);
                  }
                }
                function triggerAnimationStart() {
                  animationEntry.beforeStart();
                  var startAnimationFn,
                      closeFn = animationEntry.close;
                  var targetElement = animationEntry.anchors ? (animationEntry.from.element || animationEntry.to.element) : animationEntry.element;
                  if (getRunner(targetElement)) {
                    var operation = invokeFirstDriver(animationEntry);
                    if (operation) {
                      startAnimationFn = operation.start;
                    }
                  }
                  if (!startAnimationFn) {
                    closeFn();
                  } else {
                    var animationRunner = startAnimationFn();
                    animationRunner.done(function(status) {
                      closeFn(!status);
                    });
                    updateAnimationRunners(animationEntry, animationRunner);
                  }
                }
              });
            });
            return runner;
            function getAnchorNodes(node) {
              var SELECTOR = '[' + NG_ANIMATE_REF_ATTR + ']';
              var items = node.hasAttribute(NG_ANIMATE_REF_ATTR) ? [node] : node.querySelectorAll(SELECTOR);
              var anchors = [];
              forEach(items, function(node) {
                var attr = node.getAttribute(NG_ANIMATE_REF_ATTR);
                if (attr && attr.length) {
                  anchors.push(node);
                }
              });
              return anchors;
            }
            function groupAnimations(animations) {
              var preparedAnimations = [];
              var refLookup = {};
              forEach(animations, function(animation, index) {
                var element = animation.element;
                var node = getDomNode(element);
                var event = animation.event;
                var enterOrMove = ['enter', 'move'].indexOf(event) >= 0;
                var anchorNodes = animation.structural ? getAnchorNodes(node) : [];
                if (anchorNodes.length) {
                  var direction = enterOrMove ? 'to' : 'from';
                  forEach(anchorNodes, function(anchor) {
                    var key = anchor.getAttribute(NG_ANIMATE_REF_ATTR);
                    refLookup[key] = refLookup[key] || {};
                    refLookup[key][direction] = {
                      animationID: index,
                      element: jqLite(anchor)
                    };
                  });
                } else {
                  preparedAnimations.push(animation);
                }
              });
              var usedIndicesLookup = {};
              var anchorGroups = {};
              forEach(refLookup, function(operations, key) {
                var from = operations.from;
                var to = operations.to;
                if (!from || !to) {
                  var index = from ? from.animationID : to.animationID;
                  var indexKey = index.toString();
                  if (!usedIndicesLookup[indexKey]) {
                    usedIndicesLookup[indexKey] = true;
                    preparedAnimations.push(animations[index]);
                  }
                  return ;
                }
                var fromAnimation = animations[from.animationID];
                var toAnimation = animations[to.animationID];
                var lookupKey = from.animationID.toString();
                if (!anchorGroups[lookupKey]) {
                  var group = anchorGroups[lookupKey] = {
                    structural: true,
                    beforeStart: function() {
                      fromAnimation.beforeStart();
                      toAnimation.beforeStart();
                    },
                    close: function() {
                      fromAnimation.close();
                      toAnimation.close();
                    },
                    classes: cssClassesIntersection(fromAnimation.classes, toAnimation.classes),
                    from: fromAnimation,
                    to: toAnimation,
                    anchors: []
                  };
                  if (group.classes.length) {
                    preparedAnimations.push(group);
                  } else {
                    preparedAnimations.push(fromAnimation);
                    preparedAnimations.push(toAnimation);
                  }
                }
                anchorGroups[lookupKey].anchors.push({
                  'out': from.element,
                  'in': to.element
                });
              });
              return preparedAnimations;
            }
            function cssClassesIntersection(a, b) {
              a = a.split(' ');
              b = b.split(' ');
              var matches = [];
              for (var i = 0; i < a.length; i++) {
                var aa = a[i];
                if (aa.substring(0, 3) === 'ng-')
                  continue;
                for (var j = 0; j < b.length; j++) {
                  if (aa === b[j]) {
                    matches.push(aa);
                    break;
                  }
                }
              }
              return matches.join(' ');
            }
            function invokeFirstDriver(animationDetails) {
              for (var i = drivers.length - 1; i >= 0; i--) {
                var driverName = drivers[i];
                if (!$injector.has(driverName))
                  continue;
                var factory = $injector.get(driverName);
                var driver = factory(animationDetails);
                if (driver) {
                  return driver;
                }
              }
            }
            function beforeStart() {
              element.addClass(NG_ANIMATE_CLASSNAME);
              if (tempClasses) {
                $$jqLite.addClass(element, tempClasses);
              }
            }
            function updateAnimationRunners(animation, newRunner) {
              if (animation.from && animation.to) {
                update(animation.from.element);
                update(animation.to.element);
              } else {
                update(animation.element);
              }
              function update(element) {
                getRunner(element).setHost(newRunner);
              }
            }
            function handleDestroyedElement() {
              var runner = getRunner(element);
              if (runner && (event !== 'leave' || !options.$$domOperationFired)) {
                runner.end();
              }
            }
            function close(rejected) {
              element.off('$destroy', handleDestroyedElement);
              removeRunner(element);
              applyAnimationClasses(element, options);
              applyAnimationStyles(element, options);
              options.domOperation();
              if (tempClasses) {
                $$jqLite.removeClass(element, tempClasses);
              }
              element.removeClass(NG_ANIMATE_CLASSNAME);
              runner.complete(!rejected);
            }
          };
        }];
      }];
      angular.module('ngAnimate', []).directive('ngAnimateChildren', $$AnimateChildrenDirective).factory('$$rAFMutex', $$rAFMutexFactory).factory('$$rAFScheduler', $$rAFSchedulerFactory).factory('$$AnimateRunner', $$AnimateRunnerFactory).provider('$$animateQueue', $$AnimateQueueProvider).provider('$$animation', $$AnimationProvider).provider('$animateCss', $AnimateCssProvider).provider('$$animateCssDriver', $$AnimateCssDriverProvider).provider('$$animateJs', $$AnimateJsProvider).provider('$$animateJsDriver', $$AnimateJsDriverProvider);
    })(window, window.angular);
  }).call(System.global);
  return System.get("@@global-helpers").retrieveGlobal(__module.id, false);
});

System.register("github:sachinchoolur/angular-flash@1.1.0/dist/angular-flash", [], false, function(__require, __exports, __module) {
  System.get("@@global-helpers").prepareGlobal(__module.id, []);
  (function() {
    (function() {
      'use strict';
      var app = angular.module('flash', []);
      app.run(['$rootScope', function($rootScope) {
        $rootScope.flash = {};
        $rootScope.flash.text = '';
        $rootScope.flash.type = '';
        $rootScope.flash.timeout = 5000;
        $rootScope.hasFlash = false;
      }]);
      app.directive('dynamic', ['$compile', function($compile) {
        return {
          restrict: 'A',
          replace: true,
          link: function(scope, ele, attrs) {
            scope.$watch(attrs.dynamic, function(html) {
              ele.html(html);
              $compile(ele.contents())(scope);
            });
          }
        };
      }]);
      app.directive('closeFlash', ['$compile', 'Flash', function($compile, Flash) {
        return {link: function(scope, ele) {
            ele.on('click', function() {
              Flash.dismiss();
            });
          }};
      }]);
      app.directive('flashMessage', ['$compile', '$rootScope', function($compile, $rootScope) {
        return {
          restrict: 'A',
          template: '<div role="alert" ng-show="hasFlash" class="alert {{flash.addClass}} alert-{{flash.type}} alert-dismissible ng-hide alertIn alertOut "> <span dynamic="flash.text"></span> <button type="button" class="close" close-flash><span aria-hidden="true">&times;</span><span class="sr-only">Close</span></button> </div>',
          link: function(scope, ele, attrs) {
            $rootScope.flash.timeout = parseInt(attrs.flashMessage, 10);
          }
        };
      }]);
      app.factory('Flash', ['$rootScope', '$timeout', function($rootScope, $timeout) {
        var dataFactory = {},
            timeOut;
        dataFactory.create = function(type, text, addClass) {
          var $this = this;
          $timeout.cancel(timeOut);
          $rootScope.flash.type = type;
          $rootScope.flash.text = text;
          $rootScope.flash.addClass = addClass;
          $timeout(function() {
            $rootScope.hasFlash = true;
          }, 100);
          timeOut = $timeout(function() {
            $this.dismiss();
          }, $rootScope.flash.timeout);
        };
        dataFactory.pause = function() {
          $timeout.cancel(timeOut);
        };
        dataFactory.dismiss = function() {
          $timeout.cancel(timeOut);
          $timeout(function() {
            $rootScope.hasFlash = false;
          });
        };
        return dataFactory;
      }]);
    }());
  }).call(System.global);
  return System.get("@@global-helpers").retrieveGlobal(__module.id, false);
});

System.register("github:moment/moment@2.10.3/moment", [], false, function(__require, __exports, __module) {
  System.get("@@global-helpers").prepareGlobal(__module.id, []);
  (function() {
    "format global";
    (function(global, factory) {
      typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory() : typeof define === 'function' && define.amd ? define(factory) : global.moment = factory();
    }(this, function() {
      'use strict';
      var hookCallback;
      function utils_hooks__hooks() {
        return hookCallback.apply(null, arguments);
      }
      function setHookCallback(callback) {
        hookCallback = callback;
      }
      function isArray(input) {
        return Object.prototype.toString.call(input) === '[object Array]';
      }
      function isDate(input) {
        return input instanceof Date || Object.prototype.toString.call(input) === '[object Date]';
      }
      function map(arr, fn) {
        var res = [],
            i;
        for (i = 0; i < arr.length; ++i) {
          res.push(fn(arr[i], i));
        }
        return res;
      }
      function hasOwnProp(a, b) {
        return Object.prototype.hasOwnProperty.call(a, b);
      }
      function extend(a, b) {
        for (var i in b) {
          if (hasOwnProp(b, i)) {
            a[i] = b[i];
          }
        }
        if (hasOwnProp(b, 'toString')) {
          a.toString = b.toString;
        }
        if (hasOwnProp(b, 'valueOf')) {
          a.valueOf = b.valueOf;
        }
        return a;
      }
      function create_utc__createUTC(input, format, locale, strict) {
        return createLocalOrUTC(input, format, locale, strict, true).utc();
      }
      function defaultParsingFlags() {
        return {
          empty: false,
          unusedTokens: [],
          unusedInput: [],
          overflow: -2,
          charsLeftOver: 0,
          nullInput: false,
          invalidMonth: null,
          invalidFormat: false,
          userInvalidated: false,
          iso: false
        };
      }
      function getParsingFlags(m) {
        if (m._pf == null) {
          m._pf = defaultParsingFlags();
        }
        return m._pf;
      }
      function valid__isValid(m) {
        if (m._isValid == null) {
          var flags = getParsingFlags(m);
          m._isValid = !isNaN(m._d.getTime()) && flags.overflow < 0 && !flags.empty && !flags.invalidMonth && !flags.nullInput && !flags.invalidFormat && !flags.userInvalidated;
          if (m._strict) {
            m._isValid = m._isValid && flags.charsLeftOver === 0 && flags.unusedTokens.length === 0 && flags.bigHour === undefined;
          }
        }
        return m._isValid;
      }
      function valid__createInvalid(flags) {
        var m = create_utc__createUTC(NaN);
        if (flags != null) {
          extend(getParsingFlags(m), flags);
        } else {
          getParsingFlags(m).userInvalidated = true;
        }
        return m;
      }
      var momentProperties = utils_hooks__hooks.momentProperties = [];
      function copyConfig(to, from) {
        var i,
            prop,
            val;
        if (typeof from._isAMomentObject !== 'undefined') {
          to._isAMomentObject = from._isAMomentObject;
        }
        if (typeof from._i !== 'undefined') {
          to._i = from._i;
        }
        if (typeof from._f !== 'undefined') {
          to._f = from._f;
        }
        if (typeof from._l !== 'undefined') {
          to._l = from._l;
        }
        if (typeof from._strict !== 'undefined') {
          to._strict = from._strict;
        }
        if (typeof from._tzm !== 'undefined') {
          to._tzm = from._tzm;
        }
        if (typeof from._isUTC !== 'undefined') {
          to._isUTC = from._isUTC;
        }
        if (typeof from._offset !== 'undefined') {
          to._offset = from._offset;
        }
        if (typeof from._pf !== 'undefined') {
          to._pf = getParsingFlags(from);
        }
        if (typeof from._locale !== 'undefined') {
          to._locale = from._locale;
        }
        if (momentProperties.length > 0) {
          for (i in momentProperties) {
            prop = momentProperties[i];
            val = from[prop];
            if (typeof val !== 'undefined') {
              to[prop] = val;
            }
          }
        }
        return to;
      }
      var updateInProgress = false;
      function Moment(config) {
        copyConfig(this, config);
        this._d = new Date(+config._d);
        if (updateInProgress === false) {
          updateInProgress = true;
          utils_hooks__hooks.updateOffset(this);
          updateInProgress = false;
        }
      }
      function isMoment(obj) {
        return obj instanceof Moment || (obj != null && obj._isAMomentObject != null);
      }
      function toInt(argumentForCoercion) {
        var coercedNumber = +argumentForCoercion,
            value = 0;
        if (coercedNumber !== 0 && isFinite(coercedNumber)) {
          if (coercedNumber >= 0) {
            value = Math.floor(coercedNumber);
          } else {
            value = Math.ceil(coercedNumber);
          }
        }
        return value;
      }
      function compareArrays(array1, array2, dontConvert) {
        var len = Math.min(array1.length, array2.length),
            lengthDiff = Math.abs(array1.length - array2.length),
            diffs = 0,
            i;
        for (i = 0; i < len; i++) {
          if ((dontConvert && array1[i] !== array2[i]) || (!dontConvert && toInt(array1[i]) !== toInt(array2[i]))) {
            diffs++;
          }
        }
        return diffs + lengthDiff;
      }
      function Locale() {}
      var locales = {};
      var globalLocale;
      function normalizeLocale(key) {
        return key ? key.toLowerCase().replace('_', '-') : key;
      }
      function chooseLocale(names) {
        var i = 0,
            j,
            next,
            locale,
            split;
        while (i < names.length) {
          split = normalizeLocale(names[i]).split('-');
          j = split.length;
          next = normalizeLocale(names[i + 1]);
          next = next ? next.split('-') : null;
          while (j > 0) {
            locale = loadLocale(split.slice(0, j).join('-'));
            if (locale) {
              return locale;
            }
            if (next && next.length >= j && compareArrays(split, next, true) >= j - 1) {
              break;
            }
            j--;
          }
          i++;
        }
        return null;
      }
      function loadLocale(name) {
        var oldLocale = null;
        if (!locales[name] && typeof module !== 'undefined' && module && module.exports) {
          try {
            oldLocale = globalLocale._abbr;
            require('./locale/' + name);
            locale_locales__getSetGlobalLocale(oldLocale);
          } catch (e) {}
        }
        return locales[name];
      }
      function locale_locales__getSetGlobalLocale(key, values) {
        var data;
        if (key) {
          if (typeof values === 'undefined') {
            data = locale_locales__getLocale(key);
          } else {
            data = defineLocale(key, values);
          }
          if (data) {
            globalLocale = data;
          }
        }
        return globalLocale._abbr;
      }
      function defineLocale(name, values) {
        if (values !== null) {
          values.abbr = name;
          if (!locales[name]) {
            locales[name] = new Locale();
          }
          locales[name].set(values);
          locale_locales__getSetGlobalLocale(name);
          return locales[name];
        } else {
          delete locales[name];
          return null;
        }
      }
      function locale_locales__getLocale(key) {
        var locale;
        if (key && key._locale && key._locale._abbr) {
          key = key._locale._abbr;
        }
        if (!key) {
          return globalLocale;
        }
        if (!isArray(key)) {
          locale = loadLocale(key);
          if (locale) {
            return locale;
          }
          key = [key];
        }
        return chooseLocale(key);
      }
      var aliases = {};
      function addUnitAlias(unit, shorthand) {
        var lowerCase = unit.toLowerCase();
        aliases[lowerCase] = aliases[lowerCase + 's'] = aliases[shorthand] = unit;
      }
      function normalizeUnits(units) {
        return typeof units === 'string' ? aliases[units] || aliases[units.toLowerCase()] : undefined;
      }
      function normalizeObjectUnits(inputObject) {
        var normalizedInput = {},
            normalizedProp,
            prop;
        for (prop in inputObject) {
          if (hasOwnProp(inputObject, prop)) {
            normalizedProp = normalizeUnits(prop);
            if (normalizedProp) {
              normalizedInput[normalizedProp] = inputObject[prop];
            }
          }
        }
        return normalizedInput;
      }
      function makeGetSet(unit, keepTime) {
        return function(value) {
          if (value != null) {
            get_set__set(this, unit, value);
            utils_hooks__hooks.updateOffset(this, keepTime);
            return this;
          } else {
            return get_set__get(this, unit);
          }
        };
      }
      function get_set__get(mom, unit) {
        return mom._d['get' + (mom._isUTC ? 'UTC' : '') + unit]();
      }
      function get_set__set(mom, unit, value) {
        return mom._d['set' + (mom._isUTC ? 'UTC' : '') + unit](value);
      }
      function getSet(units, value) {
        var unit;
        if (typeof units === 'object') {
          for (unit in units) {
            this.set(unit, units[unit]);
          }
        } else {
          units = normalizeUnits(units);
          if (typeof this[units] === 'function') {
            return this[units](value);
          }
        }
        return this;
      }
      function zeroFill(number, targetLength, forceSign) {
        var output = '' + Math.abs(number),
            sign = number >= 0;
        while (output.length < targetLength) {
          output = '0' + output;
        }
        return (sign ? (forceSign ? '+' : '') : '-') + output;
      }
      var formattingTokens = /(\[[^\[]*\])|(\\)?(Mo|MM?M?M?|Do|DDDo|DD?D?D?|ddd?d?|do?|w[o|w]?|W[o|W]?|Q|YYYYYY|YYYYY|YYYY|YY|gg(ggg?)?|GG(GGG?)?|e|E|a|A|hh?|HH?|mm?|ss?|S{1,4}|x|X|zz?|ZZ?|.)/g;
      var localFormattingTokens = /(\[[^\[]*\])|(\\)?(LTS|LT|LL?L?L?|l{1,4})/g;
      var formatFunctions = {};
      var formatTokenFunctions = {};
      function addFormatToken(token, padded, ordinal, callback) {
        var func = callback;
        if (typeof callback === 'string') {
          func = function() {
            return this[callback]();
          };
        }
        if (token) {
          formatTokenFunctions[token] = func;
        }
        if (padded) {
          formatTokenFunctions[padded[0]] = function() {
            return zeroFill(func.apply(this, arguments), padded[1], padded[2]);
          };
        }
        if (ordinal) {
          formatTokenFunctions[ordinal] = function() {
            return this.localeData().ordinal(func.apply(this, arguments), token);
          };
        }
      }
      function removeFormattingTokens(input) {
        if (input.match(/\[[\s\S]/)) {
          return input.replace(/^\[|\]$/g, '');
        }
        return input.replace(/\\/g, '');
      }
      function makeFormatFunction(format) {
        var array = format.match(formattingTokens),
            i,
            length;
        for (i = 0, length = array.length; i < length; i++) {
          if (formatTokenFunctions[array[i]]) {
            array[i] = formatTokenFunctions[array[i]];
          } else {
            array[i] = removeFormattingTokens(array[i]);
          }
        }
        return function(mom) {
          var output = '';
          for (i = 0; i < length; i++) {
            output += array[i] instanceof Function ? array[i].call(mom, format) : array[i];
          }
          return output;
        };
      }
      function formatMoment(m, format) {
        if (!m.isValid()) {
          return m.localeData().invalidDate();
        }
        format = expandFormat(format, m.localeData());
        if (!formatFunctions[format]) {
          formatFunctions[format] = makeFormatFunction(format);
        }
        return formatFunctions[format](m);
      }
      function expandFormat(format, locale) {
        var i = 5;
        function replaceLongDateFormatTokens(input) {
          return locale.longDateFormat(input) || input;
        }
        localFormattingTokens.lastIndex = 0;
        while (i >= 0 && localFormattingTokens.test(format)) {
          format = format.replace(localFormattingTokens, replaceLongDateFormatTokens);
          localFormattingTokens.lastIndex = 0;
          i -= 1;
        }
        return format;
      }
      var match1 = /\d/;
      var match2 = /\d\d/;
      var match3 = /\d{3}/;
      var match4 = /\d{4}/;
      var match6 = /[+-]?\d{6}/;
      var match1to2 = /\d\d?/;
      var match1to3 = /\d{1,3}/;
      var match1to4 = /\d{1,4}/;
      var match1to6 = /[+-]?\d{1,6}/;
      var matchUnsigned = /\d+/;
      var matchSigned = /[+-]?\d+/;
      var matchOffset = /Z|[+-]\d\d:?\d\d/gi;
      var matchTimestamp = /[+-]?\d+(\.\d{1,3})?/;
      var matchWord = /[0-9]*['a-z\u00A0-\u05FF\u0700-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF]+|[\u0600-\u06FF\/]+(\s*?[\u0600-\u06FF]+){1,2}/i;
      var regexes = {};
      function addRegexToken(token, regex, strictRegex) {
        regexes[token] = typeof regex === 'function' ? regex : function(isStrict) {
          return (isStrict && strictRegex) ? strictRegex : regex;
        };
      }
      function getParseRegexForToken(token, config) {
        if (!hasOwnProp(regexes, token)) {
          return new RegExp(unescapeFormat(token));
        }
        return regexes[token](config._strict, config._locale);
      }
      function unescapeFormat(s) {
        return s.replace('\\', '').replace(/\\(\[)|\\(\])|\[([^\]\[]*)\]|\\(.)/g, function(matched, p1, p2, p3, p4) {
          return p1 || p2 || p3 || p4;
        }).replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
      }
      var tokens = {};
      function addParseToken(token, callback) {
        var i,
            func = callback;
        if (typeof token === 'string') {
          token = [token];
        }
        if (typeof callback === 'number') {
          func = function(input, array) {
            array[callback] = toInt(input);
          };
        }
        for (i = 0; i < token.length; i++) {
          tokens[token[i]] = func;
        }
      }
      function addWeekParseToken(token, callback) {
        addParseToken(token, function(input, array, config, token) {
          config._w = config._w || {};
          callback(input, config._w, config, token);
        });
      }
      function addTimeToArrayFromToken(token, input, config) {
        if (input != null && hasOwnProp(tokens, token)) {
          tokens[token](input, config._a, config, token);
        }
      }
      var YEAR = 0;
      var MONTH = 1;
      var DATE = 2;
      var HOUR = 3;
      var MINUTE = 4;
      var SECOND = 5;
      var MILLISECOND = 6;
      function daysInMonth(year, month) {
        return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      }
      addFormatToken('M', ['MM', 2], 'Mo', function() {
        return this.month() + 1;
      });
      addFormatToken('MMM', 0, 0, function(format) {
        return this.localeData().monthsShort(this, format);
      });
      addFormatToken('MMMM', 0, 0, function(format) {
        return this.localeData().months(this, format);
      });
      addUnitAlias('month', 'M');
      addRegexToken('M', match1to2);
      addRegexToken('MM', match1to2, match2);
      addRegexToken('MMM', matchWord);
      addRegexToken('MMMM', matchWord);
      addParseToken(['M', 'MM'], function(input, array) {
        array[MONTH] = toInt(input) - 1;
      });
      addParseToken(['MMM', 'MMMM'], function(input, array, config, token) {
        var month = config._locale.monthsParse(input, token, config._strict);
        if (month != null) {
          array[MONTH] = month;
        } else {
          getParsingFlags(config).invalidMonth = input;
        }
      });
      var defaultLocaleMonths = 'January_February_March_April_May_June_July_August_September_October_November_December'.split('_');
      function localeMonths(m) {
        return this._months[m.month()];
      }
      var defaultLocaleMonthsShort = 'Jan_Feb_Mar_Apr_May_Jun_Jul_Aug_Sep_Oct_Nov_Dec'.split('_');
      function localeMonthsShort(m) {
        return this._monthsShort[m.month()];
      }
      function localeMonthsParse(monthName, format, strict) {
        var i,
            mom,
            regex;
        if (!this._monthsParse) {
          this._monthsParse = [];
          this._longMonthsParse = [];
          this._shortMonthsParse = [];
        }
        for (i = 0; i < 12; i++) {
          mom = create_utc__createUTC([2000, i]);
          if (strict && !this._longMonthsParse[i]) {
            this._longMonthsParse[i] = new RegExp('^' + this.months(mom, '').replace('.', '') + '$', 'i');
            this._shortMonthsParse[i] = new RegExp('^' + this.monthsShort(mom, '').replace('.', '') + '$', 'i');
          }
          if (!strict && !this._monthsParse[i]) {
            regex = '^' + this.months(mom, '') + '|^' + this.monthsShort(mom, '');
            this._monthsParse[i] = new RegExp(regex.replace('.', ''), 'i');
          }
          if (strict && format === 'MMMM' && this._longMonthsParse[i].test(monthName)) {
            return i;
          } else if (strict && format === 'MMM' && this._shortMonthsParse[i].test(monthName)) {
            return i;
          } else if (!strict && this._monthsParse[i].test(monthName)) {
            return i;
          }
        }
      }
      function setMonth(mom, value) {
        var dayOfMonth;
        if (typeof value === 'string') {
          value = mom.localeData().monthsParse(value);
          if (typeof value !== 'number') {
            return mom;
          }
        }
        dayOfMonth = Math.min(mom.date(), daysInMonth(mom.year(), value));
        mom._d['set' + (mom._isUTC ? 'UTC' : '') + 'Month'](value, dayOfMonth);
        return mom;
      }
      function getSetMonth(value) {
        if (value != null) {
          setMonth(this, value);
          utils_hooks__hooks.updateOffset(this, true);
          return this;
        } else {
          return get_set__get(this, 'Month');
        }
      }
      function getDaysInMonth() {
        return daysInMonth(this.year(), this.month());
      }
      function checkOverflow(m) {
        var overflow;
        var a = m._a;
        if (a && getParsingFlags(m).overflow === -2) {
          overflow = a[MONTH] < 0 || a[MONTH] > 11 ? MONTH : a[DATE] < 1 || a[DATE] > daysInMonth(a[YEAR], a[MONTH]) ? DATE : a[HOUR] < 0 || a[HOUR] > 24 || (a[HOUR] === 24 && (a[MINUTE] !== 0 || a[SECOND] !== 0 || a[MILLISECOND] !== 0)) ? HOUR : a[MINUTE] < 0 || a[MINUTE] > 59 ? MINUTE : a[SECOND] < 0 || a[SECOND] > 59 ? SECOND : a[MILLISECOND] < 0 || a[MILLISECOND] > 999 ? MILLISECOND : -1;
          if (getParsingFlags(m)._overflowDayOfYear && (overflow < YEAR || overflow > DATE)) {
            overflow = DATE;
          }
          getParsingFlags(m).overflow = overflow;
        }
        return m;
      }
      function warn(msg) {
        if (utils_hooks__hooks.suppressDeprecationWarnings === false && typeof console !== 'undefined' && console.warn) {
          console.warn('Deprecation warning: ' + msg);
        }
      }
      function deprecate(msg, fn) {
        var firstTime = true,
            msgWithStack = msg + '\n' + (new Error()).stack;
        return extend(function() {
          if (firstTime) {
            warn(msgWithStack);
            firstTime = false;
          }
          return fn.apply(this, arguments);
        }, fn);
      }
      var deprecations = {};
      function deprecateSimple(name, msg) {
        if (!deprecations[name]) {
          warn(msg);
          deprecations[name] = true;
        }
      }
      utils_hooks__hooks.suppressDeprecationWarnings = false;
      var from_string__isoRegex = /^\s*(?:[+-]\d{6}|\d{4})-(?:(\d\d-\d\d)|(W\d\d$)|(W\d\d-\d)|(\d\d\d))((T| )(\d\d(:\d\d(:\d\d(\.\d+)?)?)?)?([\+\-]\d\d(?::?\d\d)?|\s*Z)?)?$/;
      var isoDates = [['YYYYYY-MM-DD', /[+-]\d{6}-\d{2}-\d{2}/], ['YYYY-MM-DD', /\d{4}-\d{2}-\d{2}/], ['GGGG-[W]WW-E', /\d{4}-W\d{2}-\d/], ['GGGG-[W]WW', /\d{4}-W\d{2}/], ['YYYY-DDD', /\d{4}-\d{3}/]];
      var isoTimes = [['HH:mm:ss.SSSS', /(T| )\d\d:\d\d:\d\d\.\d+/], ['HH:mm:ss', /(T| )\d\d:\d\d:\d\d/], ['HH:mm', /(T| )\d\d:\d\d/], ['HH', /(T| )\d\d/]];
      var aspNetJsonRegex = /^\/?Date\((\-?\d+)/i;
      function configFromISO(config) {
        var i,
            l,
            string = config._i,
            match = from_string__isoRegex.exec(string);
        if (match) {
          getParsingFlags(config).iso = true;
          for (i = 0, l = isoDates.length; i < l; i++) {
            if (isoDates[i][1].exec(string)) {
              config._f = isoDates[i][0] + (match[6] || ' ');
              break;
            }
          }
          for (i = 0, l = isoTimes.length; i < l; i++) {
            if (isoTimes[i][1].exec(string)) {
              config._f += isoTimes[i][0];
              break;
            }
          }
          if (string.match(matchOffset)) {
            config._f += 'Z';
          }
          configFromStringAndFormat(config);
        } else {
          config._isValid = false;
        }
      }
      function configFromString(config) {
        var matched = aspNetJsonRegex.exec(config._i);
        if (matched !== null) {
          config._d = new Date(+matched[1]);
          return ;
        }
        configFromISO(config);
        if (config._isValid === false) {
          delete config._isValid;
          utils_hooks__hooks.createFromInputFallback(config);
        }
      }
      utils_hooks__hooks.createFromInputFallback = deprecate('moment construction falls back to js Date. This is ' + 'discouraged and will be removed in upcoming major ' + 'release. Please refer to ' + 'https://github.com/moment/moment/issues/1407 for more info.', function(config) {
        config._d = new Date(config._i + (config._useUTC ? ' UTC' : ''));
      });
      function createDate(y, m, d, h, M, s, ms) {
        var date = new Date(y, m, d, h, M, s, ms);
        if (y < 1970) {
          date.setFullYear(y);
        }
        return date;
      }
      function createUTCDate(y) {
        var date = new Date(Date.UTC.apply(null, arguments));
        if (y < 1970) {
          date.setUTCFullYear(y);
        }
        return date;
      }
      addFormatToken(0, ['YY', 2], 0, function() {
        return this.year() % 100;
      });
      addFormatToken(0, ['YYYY', 4], 0, 'year');
      addFormatToken(0, ['YYYYY', 5], 0, 'year');
      addFormatToken(0, ['YYYYYY', 6, true], 0, 'year');
      addUnitAlias('year', 'y');
      addRegexToken('Y', matchSigned);
      addRegexToken('YY', match1to2, match2);
      addRegexToken('YYYY', match1to4, match4);
      addRegexToken('YYYYY', match1to6, match6);
      addRegexToken('YYYYYY', match1to6, match6);
      addParseToken(['YYYY', 'YYYYY', 'YYYYYY'], YEAR);
      addParseToken('YY', function(input, array) {
        array[YEAR] = utils_hooks__hooks.parseTwoDigitYear(input);
      });
      function daysInYear(year) {
        return isLeapYear(year) ? 366 : 365;
      }
      function isLeapYear(year) {
        return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
      }
      utils_hooks__hooks.parseTwoDigitYear = function(input) {
        return toInt(input) + (toInt(input) > 68 ? 1900 : 2000);
      };
      var getSetYear = makeGetSet('FullYear', false);
      function getIsLeapYear() {
        return isLeapYear(this.year());
      }
      addFormatToken('w', ['ww', 2], 'wo', 'week');
      addFormatToken('W', ['WW', 2], 'Wo', 'isoWeek');
      addUnitAlias('week', 'w');
      addUnitAlias('isoWeek', 'W');
      addRegexToken('w', match1to2);
      addRegexToken('ww', match1to2, match2);
      addRegexToken('W', match1to2);
      addRegexToken('WW', match1to2, match2);
      addWeekParseToken(['w', 'ww', 'W', 'WW'], function(input, week, config, token) {
        week[token.substr(0, 1)] = toInt(input);
      });
      function weekOfYear(mom, firstDayOfWeek, firstDayOfWeekOfYear) {
        var end = firstDayOfWeekOfYear - firstDayOfWeek,
            daysToDayOfWeek = firstDayOfWeekOfYear - mom.day(),
            adjustedMoment;
        if (daysToDayOfWeek > end) {
          daysToDayOfWeek -= 7;
        }
        if (daysToDayOfWeek < end - 7) {
          daysToDayOfWeek += 7;
        }
        adjustedMoment = local__createLocal(mom).add(daysToDayOfWeek, 'd');
        return {
          week: Math.ceil(adjustedMoment.dayOfYear() / 7),
          year: adjustedMoment.year()
        };
      }
      function localeWeek(mom) {
        return weekOfYear(mom, this._week.dow, this._week.doy).week;
      }
      var defaultLocaleWeek = {
        dow: 0,
        doy: 6
      };
      function localeFirstDayOfWeek() {
        return this._week.dow;
      }
      function localeFirstDayOfYear() {
        return this._week.doy;
      }
      function getSetWeek(input) {
        var week = this.localeData().week(this);
        return input == null ? week : this.add((input - week) * 7, 'd');
      }
      function getSetISOWeek(input) {
        var week = weekOfYear(this, 1, 4).week;
        return input == null ? week : this.add((input - week) * 7, 'd');
      }
      addFormatToken('DDD', ['DDDD', 3], 'DDDo', 'dayOfYear');
      addUnitAlias('dayOfYear', 'DDD');
      addRegexToken('DDD', match1to3);
      addRegexToken('DDDD', match3);
      addParseToken(['DDD', 'DDDD'], function(input, array, config) {
        config._dayOfYear = toInt(input);
      });
      function dayOfYearFromWeeks(year, week, weekday, firstDayOfWeekOfYear, firstDayOfWeek) {
        var d = createUTCDate(year, 0, 1).getUTCDay();
        var daysToAdd;
        var dayOfYear;
        d = d === 0 ? 7 : d;
        weekday = weekday != null ? weekday : firstDayOfWeek;
        daysToAdd = firstDayOfWeek - d + (d > firstDayOfWeekOfYear ? 7 : 0) - (d < firstDayOfWeek ? 7 : 0);
        dayOfYear = 7 * (week - 1) + (weekday - firstDayOfWeek) + daysToAdd + 1;
        return {
          year: dayOfYear > 0 ? year : year - 1,
          dayOfYear: dayOfYear > 0 ? dayOfYear : daysInYear(year - 1) + dayOfYear
        };
      }
      function getSetDayOfYear(input) {
        var dayOfYear = Math.round((this.clone().startOf('day') - this.clone().startOf('year')) / 864e5) + 1;
        return input == null ? dayOfYear : this.add((input - dayOfYear), 'd');
      }
      function defaults(a, b, c) {
        if (a != null) {
          return a;
        }
        if (b != null) {
          return b;
        }
        return c;
      }
      function currentDateArray(config) {
        var now = new Date();
        if (config._useUTC) {
          return [now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()];
        }
        return [now.getFullYear(), now.getMonth(), now.getDate()];
      }
      function configFromArray(config) {
        var i,
            date,
            input = [],
            currentDate,
            yearToUse;
        if (config._d) {
          return ;
        }
        currentDate = currentDateArray(config);
        if (config._w && config._a[DATE] == null && config._a[MONTH] == null) {
          dayOfYearFromWeekInfo(config);
        }
        if (config._dayOfYear) {
          yearToUse = defaults(config._a[YEAR], currentDate[YEAR]);
          if (config._dayOfYear > daysInYear(yearToUse)) {
            getParsingFlags(config)._overflowDayOfYear = true;
          }
          date = createUTCDate(yearToUse, 0, config._dayOfYear);
          config._a[MONTH] = date.getUTCMonth();
          config._a[DATE] = date.getUTCDate();
        }
        for (i = 0; i < 3 && config._a[i] == null; ++i) {
          config._a[i] = input[i] = currentDate[i];
        }
        for (; i < 7; i++) {
          config._a[i] = input[i] = (config._a[i] == null) ? (i === 2 ? 1 : 0) : config._a[i];
        }
        if (config._a[HOUR] === 24 && config._a[MINUTE] === 0 && config._a[SECOND] === 0 && config._a[MILLISECOND] === 0) {
          config._nextDay = true;
          config._a[HOUR] = 0;
        }
        config._d = (config._useUTC ? createUTCDate : createDate).apply(null, input);
        if (config._tzm != null) {
          config._d.setUTCMinutes(config._d.getUTCMinutes() - config._tzm);
        }
        if (config._nextDay) {
          config._a[HOUR] = 24;
        }
      }
      function dayOfYearFromWeekInfo(config) {
        var w,
            weekYear,
            week,
            weekday,
            dow,
            doy,
            temp;
        w = config._w;
        if (w.GG != null || w.W != null || w.E != null) {
          dow = 1;
          doy = 4;
          weekYear = defaults(w.GG, config._a[YEAR], weekOfYear(local__createLocal(), 1, 4).year);
          week = defaults(w.W, 1);
          weekday = defaults(w.E, 1);
        } else {
          dow = config._locale._week.dow;
          doy = config._locale._week.doy;
          weekYear = defaults(w.gg, config._a[YEAR], weekOfYear(local__createLocal(), dow, doy).year);
          week = defaults(w.w, 1);
          if (w.d != null) {
            weekday = w.d;
            if (weekday < dow) {
              ++week;
            }
          } else if (w.e != null) {
            weekday = w.e + dow;
          } else {
            weekday = dow;
          }
        }
        temp = dayOfYearFromWeeks(weekYear, week, weekday, doy, dow);
        config._a[YEAR] = temp.year;
        config._dayOfYear = temp.dayOfYear;
      }
      utils_hooks__hooks.ISO_8601 = function() {};
      function configFromStringAndFormat(config) {
        if (config._f === utils_hooks__hooks.ISO_8601) {
          configFromISO(config);
          return ;
        }
        config._a = [];
        getParsingFlags(config).empty = true;
        var string = '' + config._i,
            i,
            parsedInput,
            tokens,
            token,
            skipped,
            stringLength = string.length,
            totalParsedInputLength = 0;
        tokens = expandFormat(config._f, config._locale).match(formattingTokens) || [];
        for (i = 0; i < tokens.length; i++) {
          token = tokens[i];
          parsedInput = (string.match(getParseRegexForToken(token, config)) || [])[0];
          if (parsedInput) {
            skipped = string.substr(0, string.indexOf(parsedInput));
            if (skipped.length > 0) {
              getParsingFlags(config).unusedInput.push(skipped);
            }
            string = string.slice(string.indexOf(parsedInput) + parsedInput.length);
            totalParsedInputLength += parsedInput.length;
          }
          if (formatTokenFunctions[token]) {
            if (parsedInput) {
              getParsingFlags(config).empty = false;
            } else {
              getParsingFlags(config).unusedTokens.push(token);
            }
            addTimeToArrayFromToken(token, parsedInput, config);
          } else if (config._strict && !parsedInput) {
            getParsingFlags(config).unusedTokens.push(token);
          }
        }
        getParsingFlags(config).charsLeftOver = stringLength - totalParsedInputLength;
        if (string.length > 0) {
          getParsingFlags(config).unusedInput.push(string);
        }
        if (getParsingFlags(config).bigHour === true && config._a[HOUR] <= 12 && config._a[HOUR] > 0) {
          getParsingFlags(config).bigHour = undefined;
        }
        config._a[HOUR] = meridiemFixWrap(config._locale, config._a[HOUR], config._meridiem);
        configFromArray(config);
        checkOverflow(config);
      }
      function meridiemFixWrap(locale, hour, meridiem) {
        var isPm;
        if (meridiem == null) {
          return hour;
        }
        if (locale.meridiemHour != null) {
          return locale.meridiemHour(hour, meridiem);
        } else if (locale.isPM != null) {
          isPm = locale.isPM(meridiem);
          if (isPm && hour < 12) {
            hour += 12;
          }
          if (!isPm && hour === 12) {
            hour = 0;
          }
          return hour;
        } else {
          return hour;
        }
      }
      function configFromStringAndArray(config) {
        var tempConfig,
            bestMoment,
            scoreToBeat,
            i,
            currentScore;
        if (config._f.length === 0) {
          getParsingFlags(config).invalidFormat = true;
          config._d = new Date(NaN);
          return ;
        }
        for (i = 0; i < config._f.length; i++) {
          currentScore = 0;
          tempConfig = copyConfig({}, config);
          if (config._useUTC != null) {
            tempConfig._useUTC = config._useUTC;
          }
          tempConfig._f = config._f[i];
          configFromStringAndFormat(tempConfig);
          if (!valid__isValid(tempConfig)) {
            continue;
          }
          currentScore += getParsingFlags(tempConfig).charsLeftOver;
          currentScore += getParsingFlags(tempConfig).unusedTokens.length * 10;
          getParsingFlags(tempConfig).score = currentScore;
          if (scoreToBeat == null || currentScore < scoreToBeat) {
            scoreToBeat = currentScore;
            bestMoment = tempConfig;
          }
        }
        extend(config, bestMoment || tempConfig);
      }
      function configFromObject(config) {
        if (config._d) {
          return ;
        }
        var i = normalizeObjectUnits(config._i);
        config._a = [i.year, i.month, i.day || i.date, i.hour, i.minute, i.second, i.millisecond];
        configFromArray(config);
      }
      function createFromConfig(config) {
        var input = config._i,
            format = config._f,
            res;
        config._locale = config._locale || locale_locales__getLocale(config._l);
        if (input === null || (format === undefined && input === '')) {
          return valid__createInvalid({nullInput: true});
        }
        if (typeof input === 'string') {
          config._i = input = config._locale.preparse(input);
        }
        if (isMoment(input)) {
          return new Moment(checkOverflow(input));
        } else if (isArray(format)) {
          configFromStringAndArray(config);
        } else if (format) {
          configFromStringAndFormat(config);
        } else if (isDate(input)) {
          config._d = input;
        } else {
          configFromInput(config);
        }
        res = new Moment(checkOverflow(config));
        if (res._nextDay) {
          res.add(1, 'd');
          res._nextDay = undefined;
        }
        return res;
      }
      function configFromInput(config) {
        var input = config._i;
        if (input === undefined) {
          config._d = new Date();
        } else if (isDate(input)) {
          config._d = new Date(+input);
        } else if (typeof input === 'string') {
          configFromString(config);
        } else if (isArray(input)) {
          config._a = map(input.slice(0), function(obj) {
            return parseInt(obj, 10);
          });
          configFromArray(config);
        } else if (typeof(input) === 'object') {
          configFromObject(config);
        } else if (typeof(input) === 'number') {
          config._d = new Date(input);
        } else {
          utils_hooks__hooks.createFromInputFallback(config);
        }
      }
      function createLocalOrUTC(input, format, locale, strict, isUTC) {
        var c = {};
        if (typeof(locale) === 'boolean') {
          strict = locale;
          locale = undefined;
        }
        c._isAMomentObject = true;
        c._useUTC = c._isUTC = isUTC;
        c._l = locale;
        c._i = input;
        c._f = format;
        c._strict = strict;
        return createFromConfig(c);
      }
      function local__createLocal(input, format, locale, strict) {
        return createLocalOrUTC(input, format, locale, strict, false);
      }
      var prototypeMin = deprecate('moment().min is deprecated, use moment.min instead. https://github.com/moment/moment/issues/1548', function() {
        var other = local__createLocal.apply(null, arguments);
        return other < this ? this : other;
      });
      var prototypeMax = deprecate('moment().max is deprecated, use moment.max instead. https://github.com/moment/moment/issues/1548', function() {
        var other = local__createLocal.apply(null, arguments);
        return other > this ? this : other;
      });
      function pickBy(fn, moments) {
        var res,
            i;
        if (moments.length === 1 && isArray(moments[0])) {
          moments = moments[0];
        }
        if (!moments.length) {
          return local__createLocal();
        }
        res = moments[0];
        for (i = 1; i < moments.length; ++i) {
          if (moments[i][fn](res)) {
            res = moments[i];
          }
        }
        return res;
      }
      function min() {
        var args = [].slice.call(arguments, 0);
        return pickBy('isBefore', args);
      }
      function max() {
        var args = [].slice.call(arguments, 0);
        return pickBy('isAfter', args);
      }
      function Duration(duration) {
        var normalizedInput = normalizeObjectUnits(duration),
            years = normalizedInput.year || 0,
            quarters = normalizedInput.quarter || 0,
            months = normalizedInput.month || 0,
            weeks = normalizedInput.week || 0,
            days = normalizedInput.day || 0,
            hours = normalizedInput.hour || 0,
            minutes = normalizedInput.minute || 0,
            seconds = normalizedInput.second || 0,
            milliseconds = normalizedInput.millisecond || 0;
        this._milliseconds = +milliseconds + seconds * 1e3 + minutes * 6e4 + hours * 36e5;
        this._days = +days + weeks * 7;
        this._months = +months + quarters * 3 + years * 12;
        this._data = {};
        this._locale = locale_locales__getLocale();
        this._bubble();
      }
      function isDuration(obj) {
        return obj instanceof Duration;
      }
      function offset(token, separator) {
        addFormatToken(token, 0, 0, function() {
          var offset = this.utcOffset();
          var sign = '+';
          if (offset < 0) {
            offset = -offset;
            sign = '-';
          }
          return sign + zeroFill(~~(offset / 60), 2) + separator + zeroFill(~~(offset) % 60, 2);
        });
      }
      offset('Z', ':');
      offset('ZZ', '');
      addRegexToken('Z', matchOffset);
      addRegexToken('ZZ', matchOffset);
      addParseToken(['Z', 'ZZ'], function(input, array, config) {
        config._useUTC = true;
        config._tzm = offsetFromString(input);
      });
      var chunkOffset = /([\+\-]|\d\d)/gi;
      function offsetFromString(string) {
        var matches = ((string || '').match(matchOffset) || []);
        var chunk = matches[matches.length - 1] || [];
        var parts = (chunk + '').match(chunkOffset) || ['-', 0, 0];
        var minutes = +(parts[1] * 60) + toInt(parts[2]);
        return parts[0] === '+' ? minutes : -minutes;
      }
      function cloneWithOffset(input, model) {
        var res,
            diff;
        if (model._isUTC) {
          res = model.clone();
          diff = (isMoment(input) || isDate(input) ? +input : +local__createLocal(input)) - (+res);
          res._d.setTime(+res._d + diff);
          utils_hooks__hooks.updateOffset(res, false);
          return res;
        } else {
          return local__createLocal(input).local();
        }
        return model._isUTC ? local__createLocal(input).zone(model._offset || 0) : local__createLocal(input).local();
      }
      function getDateOffset(m) {
        return -Math.round(m._d.getTimezoneOffset() / 15) * 15;
      }
      utils_hooks__hooks.updateOffset = function() {};
      function getSetOffset(input, keepLocalTime) {
        var offset = this._offset || 0,
            localAdjust;
        if (input != null) {
          if (typeof input === 'string') {
            input = offsetFromString(input);
          }
          if (Math.abs(input) < 16) {
            input = input * 60;
          }
          if (!this._isUTC && keepLocalTime) {
            localAdjust = getDateOffset(this);
          }
          this._offset = input;
          this._isUTC = true;
          if (localAdjust != null) {
            this.add(localAdjust, 'm');
          }
          if (offset !== input) {
            if (!keepLocalTime || this._changeInProgress) {
              add_subtract__addSubtract(this, create__createDuration(input - offset, 'm'), 1, false);
            } else if (!this._changeInProgress) {
              this._changeInProgress = true;
              utils_hooks__hooks.updateOffset(this, true);
              this._changeInProgress = null;
            }
          }
          return this;
        } else {
          return this._isUTC ? offset : getDateOffset(this);
        }
      }
      function getSetZone(input, keepLocalTime) {
        if (input != null) {
          if (typeof input !== 'string') {
            input = -input;
          }
          this.utcOffset(input, keepLocalTime);
          return this;
        } else {
          return -this.utcOffset();
        }
      }
      function setOffsetToUTC(keepLocalTime) {
        return this.utcOffset(0, keepLocalTime);
      }
      function setOffsetToLocal(keepLocalTime) {
        if (this._isUTC) {
          this.utcOffset(0, keepLocalTime);
          this._isUTC = false;
          if (keepLocalTime) {
            this.subtract(getDateOffset(this), 'm');
          }
        }
        return this;
      }
      function setOffsetToParsedOffset() {
        if (this._tzm) {
          this.utcOffset(this._tzm);
        } else if (typeof this._i === 'string') {
          this.utcOffset(offsetFromString(this._i));
        }
        return this;
      }
      function hasAlignedHourOffset(input) {
        if (!input) {
          input = 0;
        } else {
          input = local__createLocal(input).utcOffset();
        }
        return (this.utcOffset() - input) % 60 === 0;
      }
      function isDaylightSavingTime() {
        return (this.utcOffset() > this.clone().month(0).utcOffset() || this.utcOffset() > this.clone().month(5).utcOffset());
      }
      function isDaylightSavingTimeShifted() {
        if (this._a) {
          var other = this._isUTC ? create_utc__createUTC(this._a) : local__createLocal(this._a);
          return this.isValid() && compareArrays(this._a, other.toArray()) > 0;
        }
        return false;
      }
      function isLocal() {
        return !this._isUTC;
      }
      function isUtcOffset() {
        return this._isUTC;
      }
      function isUtc() {
        return this._isUTC && this._offset === 0;
      }
      var aspNetRegex = /(\-)?(?:(\d*)\.)?(\d+)\:(\d+)(?:\:(\d+)\.?(\d{3})?)?/;
      var create__isoRegex = /^(-)?P(?:(?:([0-9,.]*)Y)?(?:([0-9,.]*)M)?(?:([0-9,.]*)D)?(?:T(?:([0-9,.]*)H)?(?:([0-9,.]*)M)?(?:([0-9,.]*)S)?)?|([0-9,.]*)W)$/;
      function create__createDuration(input, key) {
        var duration = input,
            match = null,
            sign,
            ret,
            diffRes;
        if (isDuration(input)) {
          duration = {
            ms: input._milliseconds,
            d: input._days,
            M: input._months
          };
        } else if (typeof input === 'number') {
          duration = {};
          if (key) {
            duration[key] = input;
          } else {
            duration.milliseconds = input;
          }
        } else if (!!(match = aspNetRegex.exec(input))) {
          sign = (match[1] === '-') ? -1 : 1;
          duration = {
            y: 0,
            d: toInt(match[DATE]) * sign,
            h: toInt(match[HOUR]) * sign,
            m: toInt(match[MINUTE]) * sign,
            s: toInt(match[SECOND]) * sign,
            ms: toInt(match[MILLISECOND]) * sign
          };
        } else if (!!(match = create__isoRegex.exec(input))) {
          sign = (match[1] === '-') ? -1 : 1;
          duration = {
            y: parseIso(match[2], sign),
            M: parseIso(match[3], sign),
            d: parseIso(match[4], sign),
            h: parseIso(match[5], sign),
            m: parseIso(match[6], sign),
            s: parseIso(match[7], sign),
            w: parseIso(match[8], sign)
          };
        } else if (duration == null) {
          duration = {};
        } else if (typeof duration === 'object' && ('from' in duration || 'to' in duration)) {
          diffRes = momentsDifference(local__createLocal(duration.from), local__createLocal(duration.to));
          duration = {};
          duration.ms = diffRes.milliseconds;
          duration.M = diffRes.months;
        }
        ret = new Duration(duration);
        if (isDuration(input) && hasOwnProp(input, '_locale')) {
          ret._locale = input._locale;
        }
        return ret;
      }
      create__createDuration.fn = Duration.prototype;
      function parseIso(inp, sign) {
        var res = inp && parseFloat(inp.replace(',', '.'));
        return (isNaN(res) ? 0 : res) * sign;
      }
      function positiveMomentsDifference(base, other) {
        var res = {
          milliseconds: 0,
          months: 0
        };
        res.months = other.month() - base.month() + (other.year() - base.year()) * 12;
        if (base.clone().add(res.months, 'M').isAfter(other)) {
          --res.months;
        }
        res.milliseconds = +other - +(base.clone().add(res.months, 'M'));
        return res;
      }
      function momentsDifference(base, other) {
        var res;
        other = cloneWithOffset(other, base);
        if (base.isBefore(other)) {
          res = positiveMomentsDifference(base, other);
        } else {
          res = positiveMomentsDifference(other, base);
          res.milliseconds = -res.milliseconds;
          res.months = -res.months;
        }
        return res;
      }
      function createAdder(direction, name) {
        return function(val, period) {
          var dur,
              tmp;
          if (period !== null && !isNaN(+period)) {
            deprecateSimple(name, 'moment().' + name + '(period, number) is deprecated. Please use moment().' + name + '(number, period).');
            tmp = val;
            val = period;
            period = tmp;
          }
          val = typeof val === 'string' ? +val : val;
          dur = create__createDuration(val, period);
          add_subtract__addSubtract(this, dur, direction);
          return this;
        };
      }
      function add_subtract__addSubtract(mom, duration, isAdding, updateOffset) {
        var milliseconds = duration._milliseconds,
            days = duration._days,
            months = duration._months;
        updateOffset = updateOffset == null ? true : updateOffset;
        if (milliseconds) {
          mom._d.setTime(+mom._d + milliseconds * isAdding);
        }
        if (days) {
          get_set__set(mom, 'Date', get_set__get(mom, 'Date') + days * isAdding);
        }
        if (months) {
          setMonth(mom, get_set__get(mom, 'Month') + months * isAdding);
        }
        if (updateOffset) {
          utils_hooks__hooks.updateOffset(mom, days || months);
        }
      }
      var add_subtract__add = createAdder(1, 'add');
      var add_subtract__subtract = createAdder(-1, 'subtract');
      function moment_calendar__calendar(time) {
        var now = time || local__createLocal(),
            sod = cloneWithOffset(now, this).startOf('day'),
            diff = this.diff(sod, 'days', true),
            format = diff < -6 ? 'sameElse' : diff < -1 ? 'lastWeek' : diff < 0 ? 'lastDay' : diff < 1 ? 'sameDay' : diff < 2 ? 'nextDay' : diff < 7 ? 'nextWeek' : 'sameElse';
        return this.format(this.localeData().calendar(format, this, local__createLocal(now)));
      }
      function clone() {
        return new Moment(this);
      }
      function isAfter(input, units) {
        var inputMs;
        units = normalizeUnits(typeof units !== 'undefined' ? units : 'millisecond');
        if (units === 'millisecond') {
          input = isMoment(input) ? input : local__createLocal(input);
          return +this > +input;
        } else {
          inputMs = isMoment(input) ? +input : +local__createLocal(input);
          return inputMs < +this.clone().startOf(units);
        }
      }
      function isBefore(input, units) {
        var inputMs;
        units = normalizeUnits(typeof units !== 'undefined' ? units : 'millisecond');
        if (units === 'millisecond') {
          input = isMoment(input) ? input : local__createLocal(input);
          return +this < +input;
        } else {
          inputMs = isMoment(input) ? +input : +local__createLocal(input);
          return +this.clone().endOf(units) < inputMs;
        }
      }
      function isBetween(from, to, units) {
        return this.isAfter(from, units) && this.isBefore(to, units);
      }
      function isSame(input, units) {
        var inputMs;
        units = normalizeUnits(units || 'millisecond');
        if (units === 'millisecond') {
          input = isMoment(input) ? input : local__createLocal(input);
          return +this === +input;
        } else {
          inputMs = +local__createLocal(input);
          return +(this.clone().startOf(units)) <= inputMs && inputMs <= +(this.clone().endOf(units));
        }
      }
      function absFloor(number) {
        if (number < 0) {
          return Math.ceil(number);
        } else {
          return Math.floor(number);
        }
      }
      function diff(input, units, asFloat) {
        var that = cloneWithOffset(input, this),
            zoneDelta = (that.utcOffset() - this.utcOffset()) * 6e4,
            delta,
            output;
        units = normalizeUnits(units);
        if (units === 'year' || units === 'month' || units === 'quarter') {
          output = monthDiff(this, that);
          if (units === 'quarter') {
            output = output / 3;
          } else if (units === 'year') {
            output = output / 12;
          }
        } else {
          delta = this - that;
          output = units === 'second' ? delta / 1e3 : units === 'minute' ? delta / 6e4 : units === 'hour' ? delta / 36e5 : units === 'day' ? (delta - zoneDelta) / 864e5 : units === 'week' ? (delta - zoneDelta) / 6048e5 : delta;
        }
        return asFloat ? output : absFloor(output);
      }
      function monthDiff(a, b) {
        var wholeMonthDiff = ((b.year() - a.year()) * 12) + (b.month() - a.month()),
            anchor = a.clone().add(wholeMonthDiff, 'months'),
            anchor2,
            adjust;
        if (b - anchor < 0) {
          anchor2 = a.clone().add(wholeMonthDiff - 1, 'months');
          adjust = (b - anchor) / (anchor - anchor2);
        } else {
          anchor2 = a.clone().add(wholeMonthDiff + 1, 'months');
          adjust = (b - anchor) / (anchor2 - anchor);
        }
        return -(wholeMonthDiff + adjust);
      }
      utils_hooks__hooks.defaultFormat = 'YYYY-MM-DDTHH:mm:ssZ';
      function toString() {
        return this.clone().locale('en').format('ddd MMM DD YYYY HH:mm:ss [GMT]ZZ');
      }
      function moment_format__toISOString() {
        var m = this.clone().utc();
        if (0 < m.year() && m.year() <= 9999) {
          if ('function' === typeof Date.prototype.toISOString) {
            return this.toDate().toISOString();
          } else {
            return formatMoment(m, 'YYYY-MM-DD[T]HH:mm:ss.SSS[Z]');
          }
        } else {
          return formatMoment(m, 'YYYYYY-MM-DD[T]HH:mm:ss.SSS[Z]');
        }
      }
      function format(inputString) {
        var output = formatMoment(this, inputString || utils_hooks__hooks.defaultFormat);
        return this.localeData().postformat(output);
      }
      function from(time, withoutSuffix) {
        if (!this.isValid()) {
          return this.localeData().invalidDate();
        }
        return create__createDuration({
          to: this,
          from: time
        }).locale(this.locale()).humanize(!withoutSuffix);
      }
      function fromNow(withoutSuffix) {
        return this.from(local__createLocal(), withoutSuffix);
      }
      function to(time, withoutSuffix) {
        if (!this.isValid()) {
          return this.localeData().invalidDate();
        }
        return create__createDuration({
          from: this,
          to: time
        }).locale(this.locale()).humanize(!withoutSuffix);
      }
      function toNow(withoutSuffix) {
        return this.to(local__createLocal(), withoutSuffix);
      }
      function locale(key) {
        var newLocaleData;
        if (key === undefined) {
          return this._locale._abbr;
        } else {
          newLocaleData = locale_locales__getLocale(key);
          if (newLocaleData != null) {
            this._locale = newLocaleData;
          }
          return this;
        }
      }
      var lang = deprecate('moment().lang() is deprecated. Instead, use moment().localeData() to get the language configuration. Use moment().locale() to change languages.', function(key) {
        if (key === undefined) {
          return this.localeData();
        } else {
          return this.locale(key);
        }
      });
      function localeData() {
        return this._locale;
      }
      function startOf(units) {
        units = normalizeUnits(units);
        switch (units) {
          case 'year':
            this.month(0);
          case 'quarter':
          case 'month':
            this.date(1);
          case 'week':
          case 'isoWeek':
          case 'day':
            this.hours(0);
          case 'hour':
            this.minutes(0);
          case 'minute':
            this.seconds(0);
          case 'second':
            this.milliseconds(0);
        }
        if (units === 'week') {
          this.weekday(0);
        }
        if (units === 'isoWeek') {
          this.isoWeekday(1);
        }
        if (units === 'quarter') {
          this.month(Math.floor(this.month() / 3) * 3);
        }
        return this;
      }
      function endOf(units) {
        units = normalizeUnits(units);
        if (units === undefined || units === 'millisecond') {
          return this;
        }
        return this.startOf(units).add(1, (units === 'isoWeek' ? 'week' : units)).subtract(1, 'ms');
      }
      function to_type__valueOf() {
        return +this._d - ((this._offset || 0) * 60000);
      }
      function unix() {
        return Math.floor(+this / 1000);
      }
      function toDate() {
        return this._offset ? new Date(+this) : this._d;
      }
      function toArray() {
        var m = this;
        return [m.year(), m.month(), m.date(), m.hour(), m.minute(), m.second(), m.millisecond()];
      }
      function moment_valid__isValid() {
        return valid__isValid(this);
      }
      function parsingFlags() {
        return extend({}, getParsingFlags(this));
      }
      function invalidAt() {
        return getParsingFlags(this).overflow;
      }
      addFormatToken(0, ['gg', 2], 0, function() {
        return this.weekYear() % 100;
      });
      addFormatToken(0, ['GG', 2], 0, function() {
        return this.isoWeekYear() % 100;
      });
      function addWeekYearFormatToken(token, getter) {
        addFormatToken(0, [token, token.length], 0, getter);
      }
      addWeekYearFormatToken('gggg', 'weekYear');
      addWeekYearFormatToken('ggggg', 'weekYear');
      addWeekYearFormatToken('GGGG', 'isoWeekYear');
      addWeekYearFormatToken('GGGGG', 'isoWeekYear');
      addUnitAlias('weekYear', 'gg');
      addUnitAlias('isoWeekYear', 'GG');
      addRegexToken('G', matchSigned);
      addRegexToken('g', matchSigned);
      addRegexToken('GG', match1to2, match2);
      addRegexToken('gg', match1to2, match2);
      addRegexToken('GGGG', match1to4, match4);
      addRegexToken('gggg', match1to4, match4);
      addRegexToken('GGGGG', match1to6, match6);
      addRegexToken('ggggg', match1to6, match6);
      addWeekParseToken(['gggg', 'ggggg', 'GGGG', 'GGGGG'], function(input, week, config, token) {
        week[token.substr(0, 2)] = toInt(input);
      });
      addWeekParseToken(['gg', 'GG'], function(input, week, config, token) {
        week[token] = utils_hooks__hooks.parseTwoDigitYear(input);
      });
      function weeksInYear(year, dow, doy) {
        return weekOfYear(local__createLocal([year, 11, 31 + dow - doy]), dow, doy).week;
      }
      function getSetWeekYear(input) {
        var year = weekOfYear(this, this.localeData()._week.dow, this.localeData()._week.doy).year;
        return input == null ? year : this.add((input - year), 'y');
      }
      function getSetISOWeekYear(input) {
        var year = weekOfYear(this, 1, 4).year;
        return input == null ? year : this.add((input - year), 'y');
      }
      function getISOWeeksInYear() {
        return weeksInYear(this.year(), 1, 4);
      }
      function getWeeksInYear() {
        var weekInfo = this.localeData()._week;
        return weeksInYear(this.year(), weekInfo.dow, weekInfo.doy);
      }
      addFormatToken('Q', 0, 0, 'quarter');
      addUnitAlias('quarter', 'Q');
      addRegexToken('Q', match1);
      addParseToken('Q', function(input, array) {
        array[MONTH] = (toInt(input) - 1) * 3;
      });
      function getSetQuarter(input) {
        return input == null ? Math.ceil((this.month() + 1) / 3) : this.month((input - 1) * 3 + this.month() % 3);
      }
      addFormatToken('D', ['DD', 2], 'Do', 'date');
      addUnitAlias('date', 'D');
      addRegexToken('D', match1to2);
      addRegexToken('DD', match1to2, match2);
      addRegexToken('Do', function(isStrict, locale) {
        return isStrict ? locale._ordinalParse : locale._ordinalParseLenient;
      });
      addParseToken(['D', 'DD'], DATE);
      addParseToken('Do', function(input, array) {
        array[DATE] = toInt(input.match(match1to2)[0], 10);
      });
      var getSetDayOfMonth = makeGetSet('Date', true);
      addFormatToken('d', 0, 'do', 'day');
      addFormatToken('dd', 0, 0, function(format) {
        return this.localeData().weekdaysMin(this, format);
      });
      addFormatToken('ddd', 0, 0, function(format) {
        return this.localeData().weekdaysShort(this, format);
      });
      addFormatToken('dddd', 0, 0, function(format) {
        return this.localeData().weekdays(this, format);
      });
      addFormatToken('e', 0, 0, 'weekday');
      addFormatToken('E', 0, 0, 'isoWeekday');
      addUnitAlias('day', 'd');
      addUnitAlias('weekday', 'e');
      addUnitAlias('isoWeekday', 'E');
      addRegexToken('d', match1to2);
      addRegexToken('e', match1to2);
      addRegexToken('E', match1to2);
      addRegexToken('dd', matchWord);
      addRegexToken('ddd', matchWord);
      addRegexToken('dddd', matchWord);
      addWeekParseToken(['dd', 'ddd', 'dddd'], function(input, week, config) {
        var weekday = config._locale.weekdaysParse(input);
        if (weekday != null) {
          week.d = weekday;
        } else {
          getParsingFlags(config).invalidWeekday = input;
        }
      });
      addWeekParseToken(['d', 'e', 'E'], function(input, week, config, token) {
        week[token] = toInt(input);
      });
      function parseWeekday(input, locale) {
        if (typeof input === 'string') {
          if (!isNaN(input)) {
            input = parseInt(input, 10);
          } else {
            input = locale.weekdaysParse(input);
            if (typeof input !== 'number') {
              return null;
            }
          }
        }
        return input;
      }
      var defaultLocaleWeekdays = 'Sunday_Monday_Tuesday_Wednesday_Thursday_Friday_Saturday'.split('_');
      function localeWeekdays(m) {
        return this._weekdays[m.day()];
      }
      var defaultLocaleWeekdaysShort = 'Sun_Mon_Tue_Wed_Thu_Fri_Sat'.split('_');
      function localeWeekdaysShort(m) {
        return this._weekdaysShort[m.day()];
      }
      var defaultLocaleWeekdaysMin = 'Su_Mo_Tu_We_Th_Fr_Sa'.split('_');
      function localeWeekdaysMin(m) {
        return this._weekdaysMin[m.day()];
      }
      function localeWeekdaysParse(weekdayName) {
        var i,
            mom,
            regex;
        if (!this._weekdaysParse) {
          this._weekdaysParse = [];
        }
        for (i = 0; i < 7; i++) {
          if (!this._weekdaysParse[i]) {
            mom = local__createLocal([2000, 1]).day(i);
            regex = '^' + this.weekdays(mom, '') + '|^' + this.weekdaysShort(mom, '') + '|^' + this.weekdaysMin(mom, '');
            this._weekdaysParse[i] = new RegExp(regex.replace('.', ''), 'i');
          }
          if (this._weekdaysParse[i].test(weekdayName)) {
            return i;
          }
        }
      }
      function getSetDayOfWeek(input) {
        var day = this._isUTC ? this._d.getUTCDay() : this._d.getDay();
        if (input != null) {
          input = parseWeekday(input, this.localeData());
          return this.add(input - day, 'd');
        } else {
          return day;
        }
      }
      function getSetLocaleDayOfWeek(input) {
        var weekday = (this.day() + 7 - this.localeData()._week.dow) % 7;
        return input == null ? weekday : this.add(input - weekday, 'd');
      }
      function getSetISODayOfWeek(input) {
        return input == null ? this.day() || 7 : this.day(this.day() % 7 ? input : input - 7);
      }
      addFormatToken('H', ['HH', 2], 0, 'hour');
      addFormatToken('h', ['hh', 2], 0, function() {
        return this.hours() % 12 || 12;
      });
      function meridiem(token, lowercase) {
        addFormatToken(token, 0, 0, function() {
          return this.localeData().meridiem(this.hours(), this.minutes(), lowercase);
        });
      }
      meridiem('a', true);
      meridiem('A', false);
      addUnitAlias('hour', 'h');
      function matchMeridiem(isStrict, locale) {
        return locale._meridiemParse;
      }
      addRegexToken('a', matchMeridiem);
      addRegexToken('A', matchMeridiem);
      addRegexToken('H', match1to2);
      addRegexToken('h', match1to2);
      addRegexToken('HH', match1to2, match2);
      addRegexToken('hh', match1to2, match2);
      addParseToken(['H', 'HH'], HOUR);
      addParseToken(['a', 'A'], function(input, array, config) {
        config._isPm = config._locale.isPM(input);
        config._meridiem = input;
      });
      addParseToken(['h', 'hh'], function(input, array, config) {
        array[HOUR] = toInt(input);
        getParsingFlags(config).bigHour = true;
      });
      function localeIsPM(input) {
        return ((input + '').toLowerCase().charAt(0) === 'p');
      }
      var defaultLocaleMeridiemParse = /[ap]\.?m?\.?/i;
      function localeMeridiem(hours, minutes, isLower) {
        if (hours > 11) {
          return isLower ? 'pm' : 'PM';
        } else {
          return isLower ? 'am' : 'AM';
        }
      }
      var getSetHour = makeGetSet('Hours', true);
      addFormatToken('m', ['mm', 2], 0, 'minute');
      addUnitAlias('minute', 'm');
      addRegexToken('m', match1to2);
      addRegexToken('mm', match1to2, match2);
      addParseToken(['m', 'mm'], MINUTE);
      var getSetMinute = makeGetSet('Minutes', false);
      addFormatToken('s', ['ss', 2], 0, 'second');
      addUnitAlias('second', 's');
      addRegexToken('s', match1to2);
      addRegexToken('ss', match1to2, match2);
      addParseToken(['s', 'ss'], SECOND);
      var getSetSecond = makeGetSet('Seconds', false);
      addFormatToken('S', 0, 0, function() {
        return ~~(this.millisecond() / 100);
      });
      addFormatToken(0, ['SS', 2], 0, function() {
        return ~~(this.millisecond() / 10);
      });
      function millisecond__milliseconds(token) {
        addFormatToken(0, [token, 3], 0, 'millisecond');
      }
      millisecond__milliseconds('SSS');
      millisecond__milliseconds('SSSS');
      addUnitAlias('millisecond', 'ms');
      addRegexToken('S', match1to3, match1);
      addRegexToken('SS', match1to3, match2);
      addRegexToken('SSS', match1to3, match3);
      addRegexToken('SSSS', matchUnsigned);
      addParseToken(['S', 'SS', 'SSS', 'SSSS'], function(input, array) {
        array[MILLISECOND] = toInt(('0.' + input) * 1000);
      });
      var getSetMillisecond = makeGetSet('Milliseconds', false);
      addFormatToken('z', 0, 0, 'zoneAbbr');
      addFormatToken('zz', 0, 0, 'zoneName');
      function getZoneAbbr() {
        return this._isUTC ? 'UTC' : '';
      }
      function getZoneName() {
        return this._isUTC ? 'Coordinated Universal Time' : '';
      }
      var momentPrototype__proto = Moment.prototype;
      momentPrototype__proto.add = add_subtract__add;
      momentPrototype__proto.calendar = moment_calendar__calendar;
      momentPrototype__proto.clone = clone;
      momentPrototype__proto.diff = diff;
      momentPrototype__proto.endOf = endOf;
      momentPrototype__proto.format = format;
      momentPrototype__proto.from = from;
      momentPrototype__proto.fromNow = fromNow;
      momentPrototype__proto.to = to;
      momentPrototype__proto.toNow = toNow;
      momentPrototype__proto.get = getSet;
      momentPrototype__proto.invalidAt = invalidAt;
      momentPrototype__proto.isAfter = isAfter;
      momentPrototype__proto.isBefore = isBefore;
      momentPrototype__proto.isBetween = isBetween;
      momentPrototype__proto.isSame = isSame;
      momentPrototype__proto.isValid = moment_valid__isValid;
      momentPrototype__proto.lang = lang;
      momentPrototype__proto.locale = locale;
      momentPrototype__proto.localeData = localeData;
      momentPrototype__proto.max = prototypeMax;
      momentPrototype__proto.min = prototypeMin;
      momentPrototype__proto.parsingFlags = parsingFlags;
      momentPrototype__proto.set = getSet;
      momentPrototype__proto.startOf = startOf;
      momentPrototype__proto.subtract = add_subtract__subtract;
      momentPrototype__proto.toArray = toArray;
      momentPrototype__proto.toDate = toDate;
      momentPrototype__proto.toISOString = moment_format__toISOString;
      momentPrototype__proto.toJSON = moment_format__toISOString;
      momentPrototype__proto.toString = toString;
      momentPrototype__proto.unix = unix;
      momentPrototype__proto.valueOf = to_type__valueOf;
      momentPrototype__proto.year = getSetYear;
      momentPrototype__proto.isLeapYear = getIsLeapYear;
      momentPrototype__proto.weekYear = getSetWeekYear;
      momentPrototype__proto.isoWeekYear = getSetISOWeekYear;
      momentPrototype__proto.quarter = momentPrototype__proto.quarters = getSetQuarter;
      momentPrototype__proto.month = getSetMonth;
      momentPrototype__proto.daysInMonth = getDaysInMonth;
      momentPrototype__proto.week = momentPrototype__proto.weeks = getSetWeek;
      momentPrototype__proto.isoWeek = momentPrototype__proto.isoWeeks = getSetISOWeek;
      momentPrototype__proto.weeksInYear = getWeeksInYear;
      momentPrototype__proto.isoWeeksInYear = getISOWeeksInYear;
      momentPrototype__proto.date = getSetDayOfMonth;
      momentPrototype__proto.day = momentPrototype__proto.days = getSetDayOfWeek;
      momentPrototype__proto.weekday = getSetLocaleDayOfWeek;
      momentPrototype__proto.isoWeekday = getSetISODayOfWeek;
      momentPrototype__proto.dayOfYear = getSetDayOfYear;
      momentPrototype__proto.hour = momentPrototype__proto.hours = getSetHour;
      momentPrototype__proto.minute = momentPrototype__proto.minutes = getSetMinute;
      momentPrototype__proto.second = momentPrototype__proto.seconds = getSetSecond;
      momentPrototype__proto.millisecond = momentPrototype__proto.milliseconds = getSetMillisecond;
      momentPrototype__proto.utcOffset = getSetOffset;
      momentPrototype__proto.utc = setOffsetToUTC;
      momentPrototype__proto.local = setOffsetToLocal;
      momentPrototype__proto.parseZone = setOffsetToParsedOffset;
      momentPrototype__proto.hasAlignedHourOffset = hasAlignedHourOffset;
      momentPrototype__proto.isDST = isDaylightSavingTime;
      momentPrototype__proto.isDSTShifted = isDaylightSavingTimeShifted;
      momentPrototype__proto.isLocal = isLocal;
      momentPrototype__proto.isUtcOffset = isUtcOffset;
      momentPrototype__proto.isUtc = isUtc;
      momentPrototype__proto.isUTC = isUtc;
      momentPrototype__proto.zoneAbbr = getZoneAbbr;
      momentPrototype__proto.zoneName = getZoneName;
      momentPrototype__proto.dates = deprecate('dates accessor is deprecated. Use date instead.', getSetDayOfMonth);
      momentPrototype__proto.months = deprecate('months accessor is deprecated. Use month instead', getSetMonth);
      momentPrototype__proto.years = deprecate('years accessor is deprecated. Use year instead', getSetYear);
      momentPrototype__proto.zone = deprecate('moment().zone is deprecated, use moment().utcOffset instead. https://github.com/moment/moment/issues/1779', getSetZone);
      var momentPrototype = momentPrototype__proto;
      function moment__createUnix(input) {
        return local__createLocal(input * 1000);
      }
      function moment__createInZone() {
        return local__createLocal.apply(null, arguments).parseZone();
      }
      var defaultCalendar = {
        sameDay: '[Today at] LT',
        nextDay: '[Tomorrow at] LT',
        nextWeek: 'dddd [at] LT',
        lastDay: '[Yesterday at] LT',
        lastWeek: '[Last] dddd [at] LT',
        sameElse: 'L'
      };
      function locale_calendar__calendar(key, mom, now) {
        var output = this._calendar[key];
        return typeof output === 'function' ? output.call(mom, now) : output;
      }
      var defaultLongDateFormat = {
        LTS: 'h:mm:ss A',
        LT: 'h:mm A',
        L: 'MM/DD/YYYY',
        LL: 'MMMM D, YYYY',
        LLL: 'MMMM D, YYYY LT',
        LLLL: 'dddd, MMMM D, YYYY LT'
      };
      function longDateFormat(key) {
        var output = this._longDateFormat[key];
        if (!output && this._longDateFormat[key.toUpperCase()]) {
          output = this._longDateFormat[key.toUpperCase()].replace(/MMMM|MM|DD|dddd/g, function(val) {
            return val.slice(1);
          });
          this._longDateFormat[key] = output;
        }
        return output;
      }
      var defaultInvalidDate = 'Invalid date';
      function invalidDate() {
        return this._invalidDate;
      }
      var defaultOrdinal = '%d';
      var defaultOrdinalParse = /\d{1,2}/;
      function ordinal(number) {
        return this._ordinal.replace('%d', number);
      }
      function preParsePostFormat(string) {
        return string;
      }
      var defaultRelativeTime = {
        future: 'in %s',
        past: '%s ago',
        s: 'a few seconds',
        m: 'a minute',
        mm: '%d minutes',
        h: 'an hour',
        hh: '%d hours',
        d: 'a day',
        dd: '%d days',
        M: 'a month',
        MM: '%d months',
        y: 'a year',
        yy: '%d years'
      };
      function relative__relativeTime(number, withoutSuffix, string, isFuture) {
        var output = this._relativeTime[string];
        return (typeof output === 'function') ? output(number, withoutSuffix, string, isFuture) : output.replace(/%d/i, number);
      }
      function pastFuture(diff, output) {
        var format = this._relativeTime[diff > 0 ? 'future' : 'past'];
        return typeof format === 'function' ? format(output) : format.replace(/%s/i, output);
      }
      function locale_set__set(config) {
        var prop,
            i;
        for (i in config) {
          prop = config[i];
          if (typeof prop === 'function') {
            this[i] = prop;
          } else {
            this['_' + i] = prop;
          }
        }
        this._ordinalParseLenient = new RegExp(this._ordinalParse.source + '|' + (/\d{1,2}/).source);
      }
      var prototype__proto = Locale.prototype;
      prototype__proto._calendar = defaultCalendar;
      prototype__proto.calendar = locale_calendar__calendar;
      prototype__proto._longDateFormat = defaultLongDateFormat;
      prototype__proto.longDateFormat = longDateFormat;
      prototype__proto._invalidDate = defaultInvalidDate;
      prototype__proto.invalidDate = invalidDate;
      prototype__proto._ordinal = defaultOrdinal;
      prototype__proto.ordinal = ordinal;
      prototype__proto._ordinalParse = defaultOrdinalParse;
      prototype__proto.preparse = preParsePostFormat;
      prototype__proto.postformat = preParsePostFormat;
      prototype__proto._relativeTime = defaultRelativeTime;
      prototype__proto.relativeTime = relative__relativeTime;
      prototype__proto.pastFuture = pastFuture;
      prototype__proto.set = locale_set__set;
      prototype__proto.months = localeMonths;
      prototype__proto._months = defaultLocaleMonths;
      prototype__proto.monthsShort = localeMonthsShort;
      prototype__proto._monthsShort = defaultLocaleMonthsShort;
      prototype__proto.monthsParse = localeMonthsParse;
      prototype__proto.week = localeWeek;
      prototype__proto._week = defaultLocaleWeek;
      prototype__proto.firstDayOfYear = localeFirstDayOfYear;
      prototype__proto.firstDayOfWeek = localeFirstDayOfWeek;
      prototype__proto.weekdays = localeWeekdays;
      prototype__proto._weekdays = defaultLocaleWeekdays;
      prototype__proto.weekdaysMin = localeWeekdaysMin;
      prototype__proto._weekdaysMin = defaultLocaleWeekdaysMin;
      prototype__proto.weekdaysShort = localeWeekdaysShort;
      prototype__proto._weekdaysShort = defaultLocaleWeekdaysShort;
      prototype__proto.weekdaysParse = localeWeekdaysParse;
      prototype__proto.isPM = localeIsPM;
      prototype__proto._meridiemParse = defaultLocaleMeridiemParse;
      prototype__proto.meridiem = localeMeridiem;
      function lists__get(format, index, field, setter) {
        var locale = locale_locales__getLocale();
        var utc = create_utc__createUTC().set(setter, index);
        return locale[field](utc, format);
      }
      function list(format, index, field, count, setter) {
        if (typeof format === 'number') {
          index = format;
          format = undefined;
        }
        format = format || '';
        if (index != null) {
          return lists__get(format, index, field, setter);
        }
        var i;
        var out = [];
        for (i = 0; i < count; i++) {
          out[i] = lists__get(format, i, field, setter);
        }
        return out;
      }
      function lists__listMonths(format, index) {
        return list(format, index, 'months', 12, 'month');
      }
      function lists__listMonthsShort(format, index) {
        return list(format, index, 'monthsShort', 12, 'month');
      }
      function lists__listWeekdays(format, index) {
        return list(format, index, 'weekdays', 7, 'day');
      }
      function lists__listWeekdaysShort(format, index) {
        return list(format, index, 'weekdaysShort', 7, 'day');
      }
      function lists__listWeekdaysMin(format, index) {
        return list(format, index, 'weekdaysMin', 7, 'day');
      }
      locale_locales__getSetGlobalLocale('en', {
        ordinalParse: /\d{1,2}(th|st|nd|rd)/,
        ordinal: function(number) {
          var b = number % 10,
              output = (toInt(number % 100 / 10) === 1) ? 'th' : (b === 1) ? 'st' : (b === 2) ? 'nd' : (b === 3) ? 'rd' : 'th';
          return number + output;
        }
      });
      utils_hooks__hooks.lang = deprecate('moment.lang is deprecated. Use moment.locale instead.', locale_locales__getSetGlobalLocale);
      utils_hooks__hooks.langData = deprecate('moment.langData is deprecated. Use moment.localeData instead.', locale_locales__getLocale);
      var mathAbs = Math.abs;
      function duration_abs__abs() {
        var data = this._data;
        this._milliseconds = mathAbs(this._milliseconds);
        this._days = mathAbs(this._days);
        this._months = mathAbs(this._months);
        data.milliseconds = mathAbs(data.milliseconds);
        data.seconds = mathAbs(data.seconds);
        data.minutes = mathAbs(data.minutes);
        data.hours = mathAbs(data.hours);
        data.months = mathAbs(data.months);
        data.years = mathAbs(data.years);
        return this;
      }
      function duration_add_subtract__addSubtract(duration, input, value, direction) {
        var other = create__createDuration(input, value);
        duration._milliseconds += direction * other._milliseconds;
        duration._days += direction * other._days;
        duration._months += direction * other._months;
        return duration._bubble();
      }
      function duration_add_subtract__add(input, value) {
        return duration_add_subtract__addSubtract(this, input, value, 1);
      }
      function duration_add_subtract__subtract(input, value) {
        return duration_add_subtract__addSubtract(this, input, value, -1);
      }
      function bubble() {
        var milliseconds = this._milliseconds;
        var days = this._days;
        var months = this._months;
        var data = this._data;
        var seconds,
            minutes,
            hours,
            years = 0;
        data.milliseconds = milliseconds % 1000;
        seconds = absFloor(milliseconds / 1000);
        data.seconds = seconds % 60;
        minutes = absFloor(seconds / 60);
        data.minutes = minutes % 60;
        hours = absFloor(minutes / 60);
        data.hours = hours % 24;
        days += absFloor(hours / 24);
        years = absFloor(daysToYears(days));
        days -= absFloor(yearsToDays(years));
        months += absFloor(days / 30);
        days %= 30;
        years += absFloor(months / 12);
        months %= 12;
        data.days = days;
        data.months = months;
        data.years = years;
        return this;
      }
      function daysToYears(days) {
        return days * 400 / 146097;
      }
      function yearsToDays(years) {
        return years * 146097 / 400;
      }
      function as(units) {
        var days;
        var months;
        var milliseconds = this._milliseconds;
        units = normalizeUnits(units);
        if (units === 'month' || units === 'year') {
          days = this._days + milliseconds / 864e5;
          months = this._months + daysToYears(days) * 12;
          return units === 'month' ? months : months / 12;
        } else {
          days = this._days + Math.round(yearsToDays(this._months / 12));
          switch (units) {
            case 'week':
              return days / 7 + milliseconds / 6048e5;
            case 'day':
              return days + milliseconds / 864e5;
            case 'hour':
              return days * 24 + milliseconds / 36e5;
            case 'minute':
              return days * 1440 + milliseconds / 6e4;
            case 'second':
              return days * 86400 + milliseconds / 1000;
            case 'millisecond':
              return Math.floor(days * 864e5) + milliseconds;
            default:
              throw new Error('Unknown unit ' + units);
          }
        }
      }
      function duration_as__valueOf() {
        return (this._milliseconds + this._days * 864e5 + (this._months % 12) * 2592e6 + toInt(this._months / 12) * 31536e6);
      }
      function makeAs(alias) {
        return function() {
          return this.as(alias);
        };
      }
      var asMilliseconds = makeAs('ms');
      var asSeconds = makeAs('s');
      var asMinutes = makeAs('m');
      var asHours = makeAs('h');
      var asDays = makeAs('d');
      var asWeeks = makeAs('w');
      var asMonths = makeAs('M');
      var asYears = makeAs('y');
      function duration_get__get(units) {
        units = normalizeUnits(units);
        return this[units + 's']();
      }
      function makeGetter(name) {
        return function() {
          return this._data[name];
        };
      }
      var duration_get__milliseconds = makeGetter('milliseconds');
      var seconds = makeGetter('seconds');
      var minutes = makeGetter('minutes');
      var hours = makeGetter('hours');
      var days = makeGetter('days');
      var months = makeGetter('months');
      var years = makeGetter('years');
      function weeks() {
        return absFloor(this.days() / 7);
      }
      var round = Math.round;
      var thresholds = {
        s: 45,
        m: 45,
        h: 22,
        d: 26,
        M: 11
      };
      function substituteTimeAgo(string, number, withoutSuffix, isFuture, locale) {
        return locale.relativeTime(number || 1, !!withoutSuffix, string, isFuture);
      }
      function duration_humanize__relativeTime(posNegDuration, withoutSuffix, locale) {
        var duration = create__createDuration(posNegDuration).abs();
        var seconds = round(duration.as('s'));
        var minutes = round(duration.as('m'));
        var hours = round(duration.as('h'));
        var days = round(duration.as('d'));
        var months = round(duration.as('M'));
        var years = round(duration.as('y'));
        var a = seconds < thresholds.s && ['s', seconds] || minutes === 1 && ['m'] || minutes < thresholds.m && ['mm', minutes] || hours === 1 && ['h'] || hours < thresholds.h && ['hh', hours] || days === 1 && ['d'] || days < thresholds.d && ['dd', days] || months === 1 && ['M'] || months < thresholds.M && ['MM', months] || years === 1 && ['y'] || ['yy', years];
        a[2] = withoutSuffix;
        a[3] = +posNegDuration > 0;
        a[4] = locale;
        return substituteTimeAgo.apply(null, a);
      }
      function duration_humanize__getSetRelativeTimeThreshold(threshold, limit) {
        if (thresholds[threshold] === undefined) {
          return false;
        }
        if (limit === undefined) {
          return thresholds[threshold];
        }
        thresholds[threshold] = limit;
        return true;
      }
      function humanize(withSuffix) {
        var locale = this.localeData();
        var output = duration_humanize__relativeTime(this, !withSuffix, locale);
        if (withSuffix) {
          output = locale.pastFuture(+this, output);
        }
        return locale.postformat(output);
      }
      var iso_string__abs = Math.abs;
      function iso_string__toISOString() {
        var Y = iso_string__abs(this.years());
        var M = iso_string__abs(this.months());
        var D = iso_string__abs(this.days());
        var h = iso_string__abs(this.hours());
        var m = iso_string__abs(this.minutes());
        var s = iso_string__abs(this.seconds() + this.milliseconds() / 1000);
        var total = this.asSeconds();
        if (!total) {
          return 'P0D';
        }
        return (total < 0 ? '-' : '') + 'P' + (Y ? Y + 'Y' : '') + (M ? M + 'M' : '') + (D ? D + 'D' : '') + ((h || m || s) ? 'T' : '') + (h ? h + 'H' : '') + (m ? m + 'M' : '') + (s ? s + 'S' : '');
      }
      var duration_prototype__proto = Duration.prototype;
      duration_prototype__proto.abs = duration_abs__abs;
      duration_prototype__proto.add = duration_add_subtract__add;
      duration_prototype__proto.subtract = duration_add_subtract__subtract;
      duration_prototype__proto.as = as;
      duration_prototype__proto.asMilliseconds = asMilliseconds;
      duration_prototype__proto.asSeconds = asSeconds;
      duration_prototype__proto.asMinutes = asMinutes;
      duration_prototype__proto.asHours = asHours;
      duration_prototype__proto.asDays = asDays;
      duration_prototype__proto.asWeeks = asWeeks;
      duration_prototype__proto.asMonths = asMonths;
      duration_prototype__proto.asYears = asYears;
      duration_prototype__proto.valueOf = duration_as__valueOf;
      duration_prototype__proto._bubble = bubble;
      duration_prototype__proto.get = duration_get__get;
      duration_prototype__proto.milliseconds = duration_get__milliseconds;
      duration_prototype__proto.seconds = seconds;
      duration_prototype__proto.minutes = minutes;
      duration_prototype__proto.hours = hours;
      duration_prototype__proto.days = days;
      duration_prototype__proto.weeks = weeks;
      duration_prototype__proto.months = months;
      duration_prototype__proto.years = years;
      duration_prototype__proto.humanize = humanize;
      duration_prototype__proto.toISOString = iso_string__toISOString;
      duration_prototype__proto.toString = iso_string__toISOString;
      duration_prototype__proto.toJSON = iso_string__toISOString;
      duration_prototype__proto.locale = locale;
      duration_prototype__proto.localeData = localeData;
      duration_prototype__proto.toIsoString = deprecate('toIsoString() is deprecated. Please use toISOString() instead (notice the capitals)', iso_string__toISOString);
      duration_prototype__proto.lang = lang;
      addFormatToken('X', 0, 0, 'unix');
      addFormatToken('x', 0, 0, 'valueOf');
      addRegexToken('x', matchSigned);
      addRegexToken('X', matchTimestamp);
      addParseToken('X', function(input, array, config) {
        config._d = new Date(parseFloat(input, 10) * 1000);
      });
      addParseToken('x', function(input, array, config) {
        config._d = new Date(toInt(input));
      });
      utils_hooks__hooks.version = '2.10.3';
      setHookCallback(local__createLocal);
      utils_hooks__hooks.fn = momentPrototype;
      utils_hooks__hooks.min = min;
      utils_hooks__hooks.max = max;
      utils_hooks__hooks.utc = create_utc__createUTC;
      utils_hooks__hooks.unix = moment__createUnix;
      utils_hooks__hooks.months = lists__listMonths;
      utils_hooks__hooks.isDate = isDate;
      utils_hooks__hooks.locale = locale_locales__getSetGlobalLocale;
      utils_hooks__hooks.invalid = valid__createInvalid;
      utils_hooks__hooks.duration = create__createDuration;
      utils_hooks__hooks.isMoment = isMoment;
      utils_hooks__hooks.weekdays = lists__listWeekdays;
      utils_hooks__hooks.parseZone = moment__createInZone;
      utils_hooks__hooks.localeData = locale_locales__getLocale;
      utils_hooks__hooks.isDuration = isDuration;
      utils_hooks__hooks.monthsShort = lists__listMonthsShort;
      utils_hooks__hooks.weekdaysMin = lists__listWeekdaysMin;
      utils_hooks__hooks.defineLocale = defineLocale;
      utils_hooks__hooks.weekdaysShort = lists__listWeekdaysShort;
      utils_hooks__hooks.normalizeUnits = normalizeUnits;
      utils_hooks__hooks.relativeTimeThreshold = duration_humanize__getSetRelativeTimeThreshold;
      var _moment = utils_hooks__hooks;
      return _moment;
    }));
  }).call(System.global);
  return System.get("@@global-helpers").retrieveGlobal(__module.id, false);
});

System.register("npm:core-js@0.9.17/library/modules/$.fw", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = function($) {
    $.FW = false;
    $.path = $.core;
    return $;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.5.8/helpers/class-call-check", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "use strict";
  exports["default"] = function(instance, Constructor) {
    if (!(instance instanceof Constructor)) {
      throw new TypeError("Cannot call a class as a function");
    }
  };
  exports.__esModule = true;
  global.define = __define;
  return module.exports;
});

System.register("github:angular/bower-angular@1.4.1", ["github:angular/bower-angular@1.4.1/angular"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("github:angular/bower-angular@1.4.1/angular");
  global.define = __define;
  return module.exports;
});

System.register("github:angular/bower-angular-route@1.4.1", ["github:angular/bower-angular-route@1.4.1/angular-route"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("github:angular/bower-angular-route@1.4.1/angular-route");
  global.define = __define;
  return module.exports;
});

System.register("github:angular/bower-angular-animate@1.4.1", ["github:angular/bower-angular-animate@1.4.1/angular-animate"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("github:angular/bower-angular-animate@1.4.1/angular-animate");
  global.define = __define;
  return module.exports;
});

System.register("github:sachinchoolur/angular-flash@1.1.0", ["github:sachinchoolur/angular-flash@1.1.0/dist/angular-flash"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("github:sachinchoolur/angular-flash@1.1.0/dist/angular-flash");
  global.define = __define;
  return module.exports;
});

System.register("github:moment/moment@2.10.3", ["github:moment/moment@2.10.3/moment"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("github:moment/moment@2.10.3/moment");
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.17/library/modules/$", ["npm:core-js@0.9.17/library/modules/$.fw"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var global = typeof self != 'undefined' ? self : Function('return this')(),
      core = {},
      defineProperty = Object.defineProperty,
      hasOwnProperty = {}.hasOwnProperty,
      ceil = Math.ceil,
      floor = Math.floor,
      max = Math.max,
      min = Math.min;
  var DESC = !!function() {
    try {
      return defineProperty({}, 'a', {get: function() {
          return 2;
        }}).a == 2;
    } catch (e) {}
  }();
  var hide = createDefiner(1);
  function toInteger(it) {
    return isNaN(it = +it) ? 0 : (it > 0 ? floor : ceil)(it);
  }
  function desc(bitmap, value) {
    return {
      enumerable: !(bitmap & 1),
      configurable: !(bitmap & 2),
      writable: !(bitmap & 4),
      value: value
    };
  }
  function simpleSet(object, key, value) {
    object[key] = value;
    return object;
  }
  function createDefiner(bitmap) {
    return DESC ? function(object, key, value) {
      return $.setDesc(object, key, desc(bitmap, value));
    } : simpleSet;
  }
  function isObject(it) {
    return it !== null && (typeof it == 'object' || typeof it == 'function');
  }
  function isFunction(it) {
    return typeof it == 'function';
  }
  function assertDefined(it) {
    if (it == undefined)
      throw TypeError("Can't call method on  " + it);
    return it;
  }
  var $ = module.exports = require("npm:core-js@0.9.17/library/modules/$.fw")({
    g: global,
    core: core,
    html: global.document && document.documentElement,
    isObject: isObject,
    isFunction: isFunction,
    that: function() {
      return this;
    },
    toInteger: toInteger,
    toLength: function(it) {
      return it > 0 ? min(toInteger(it), 0x1fffffffffffff) : 0;
    },
    toIndex: function(index, length) {
      index = toInteger(index);
      return index < 0 ? max(index + length, 0) : min(index, length);
    },
    has: function(it, key) {
      return hasOwnProperty.call(it, key);
    },
    create: Object.create,
    getProto: Object.getPrototypeOf,
    DESC: DESC,
    desc: desc,
    getDesc: Object.getOwnPropertyDescriptor,
    setDesc: defineProperty,
    setDescs: Object.defineProperties,
    getKeys: Object.keys,
    getNames: Object.getOwnPropertyNames,
    getSymbols: Object.getOwnPropertySymbols,
    assertDefined: assertDefined,
    ES5Object: Object,
    toObject: function(it) {
      return $.ES5Object(assertDefined(it));
    },
    hide: hide,
    def: createDefiner(0),
    set: global.Symbol ? simpleSet : hide,
    each: [].forEach
  });
  if (typeof __e != 'undefined')
    __e = core;
  if (typeof __g != 'undefined')
    __g = global;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.17/library/fn/object/define-property", ["npm:core-js@0.9.17/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.17/library/modules/$");
  module.exports = function defineProperty(it, key, desc) {
    return $.setDesc(it, key, desc);
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.5.8/core-js/object/define-property", ["npm:core-js@0.9.17/library/fn/object/define-property"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("npm:core-js@0.9.17/library/fn/object/define-property"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.5.8/helpers/create-class", ["npm:babel-runtime@5.5.8/core-js/object/define-property"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "use strict";
  var _Object$defineProperty = require("npm:babel-runtime@5.5.8/core-js/object/define-property")["default"];
  exports["default"] = (function() {
    function defineProperties(target, props) {
      for (var i = 0; i < props.length; i++) {
        var descriptor = props[i];
        descriptor.enumerable = descriptor.enumerable || false;
        descriptor.configurable = true;
        if ("value" in descriptor)
          descriptor.writable = true;
        _Object$defineProperty(target, descriptor.key, descriptor);
      }
    }
    return function(Constructor, protoProps, staticProps) {
      if (protoProps)
        defineProperties(Constructor.prototype, protoProps);
      if (staticProps)
        defineProperties(Constructor, staticProps);
      return Constructor;
    };
  })();
  exports.__esModule = true;
  global.define = __define;
  return module.exports;
});

System.register('tabaCrono/controllers/text', ['npm:babel-runtime@5.5.8/helpers/class-call-check'], function (_export) {
    var _classCallCheck, textCtrl;

    return {
        setters: [function (_npmBabelRuntime558HelpersClassCallCheck) {
            _classCallCheck = _npmBabelRuntime558HelpersClassCallCheck['default'];
        }],
        execute: function () {
            'use strict';

            textCtrl = function textCtrl($scope, $window, $interval) {
                _classCallCheck(this, textCtrl);

                $scope.crono = {
                    text: '',
                    command: {
                        slot: '      ',
                        mode: 0,
                        light: 'A',
                        points: '0'
                    },
                    _interval: null
                };

                $scope.$on('crono-ligth', function () {});

                $scope.submit = function () {

                    $scope.crono.command.slot = $scope.crono.text.toUpperCase().substr(0, 6);

                    $scope.sendCommand([$scope.crono.command.light, $scope.crono.command.mode, $scope.crono.command.points, $scope.crono.command.slot].join(''));
                };
            };

            _export('textCtrl', textCtrl);
        }
    };
});

//$scope.sendCommand($scope.crono.command.light + '4       ');
System.register('tabaCrono/controllers/partidor', ['npm:babel-runtime@5.5.8/helpers/class-call-check'], function (_export) {
    var _classCallCheck, partidorCtrl;

    return {
        setters: [function (_npmBabelRuntime558HelpersClassCallCheck) {
            _classCallCheck = _npmBabelRuntime558HelpersClassCallCheck['default'];
        }],
        execute: function () {
            'use strict';

            partidorCtrl = function partidorCtrl($scope, $window, $interval) {
                _classCallCheck(this, partidorCtrl);

                var pad = function pad(t) {
                    return t < 100 ? '0' + t : t;
                };

                $scope.partidor = {
                    participantes: 3,
                    promedio: 60,
                    preparacion: 20,
                    inicio: 60,
                    list: [],
                    timer: 0,
                    interval: null,
                    init: false,
                    current: 0,
                    inTimeout: false,
                    rest: 0,
                    showRest: false
                };

                ipc.on('semaforo-response', function (_trace) {

                    if (!$scope.partidor.init) {
                        console.log($scope.partidor.init);
                        $scope.sendCommand(['A', 1, 2, '000000'].join(''));
                        $scope.startCrono();
                        $scope.partidor.init = true;
                        console.log($scope.partidor.init);
                    } else {
                        setTimeout(function () {

                            if ($scope.partidor.list.length > $scope.partidor.current + 1) {

                                var proximo = $scope.partidor.list[$scope.partidor.current + 1].start;

                                var diff = proximo - $scope.partidor.timer;

                                if (diff < $scope.partidor.preparacion) {
                                    while (diff < $scope.partidor.preparacion) {
                                        $scope.partidor.list.forEach(function (elm) {

                                            if (elm.id >= $scope.partidor.current + 1) {
                                                $scope.partidor.list[elm.id].start = elm.start + 60;
                                            }
                                        });

                                        proximo = $scope.partidor.list[$scope.partidor.current + 1].start;

                                        diff = proximo - $scope.partidor.timer;
                                    } // end while
                                }

                                $scope.partidor.inTimeout = true;
                            }

                            $scope.$apply();
                        }, 1000 * 10);
                    }
                });

                $scope.startCrono = function () {
                    $scope.partidor.interval = setInterval(function () {

                        $scope.partidor.timer++;

                        if ($scope.partidor.list.length > $scope.partidor.current + 1) {
                            var proximo = $scope.partidor.list[$scope.partidor.current + 1].start;

                            var diff = proximo - $scope.partidor.timer;
                            var rest = $scope.partidor.rest = $scope.partidor.list[$scope.partidor.current].start - $scope.partidor.timer;
                            if (rest == 0) {
                                $scope.partidor.showRest = false;
                            }

                            if (rest > 0) {
                                $scope.partidor.showRest = true;
                            }

                            console.log($scope.partidor.timer, proximo, diff, $scope.partidor.current + 1);

                            if ($scope.partidor.inTimeout == true && diff <= 60 && diff > $scope.partidor.preparacion) {
                                $scope.sendToSemaforo('1' + pad(diff) + '\n');
                                $scope.partidor.current++;
                                $scope.partidor.inTimeout = false;
                            }
                        }

                        $scope.$apply();
                    }, 1000);
                };

                $scope.createPartida = function () {
                    $scope.partidor.list = [];
                    var total = parseInt($scope.partidor.participantes);
                    for (var i = 0; i < total; i++) $scope.partidor.list.push({
                        id: i,
                        start: i > 0 ? i * $scope.partidor.promedio : 0
                    });
                };

                $scope.sendToSemaforo = function (value) {
                    console.log('Envia a semaforo:' + value);
                    ipc.send('semaforo-send', value);
                };

                $scope.iniciar = function () {

                    var tt = $scope.partidor.inicio < 100 ? '0' + $scope.partidor.inicio : $scope.partidor.inicio;
                    $scope.sendCommand(['A', 0, 2, '000000'].join(''));
                    $scope.sendToSemaforo('1' + tt + '\n');
                };
            };

            _export('partidorCtrl', partidorCtrl);
        }
    };
});
System.register('tabaCrono/controllers/marquee', ['npm:babel-runtime@5.5.8/helpers/class-call-check'], function (_export) {
    var _classCallCheck, marqueeCtrl;

    return {
        setters: [function (_npmBabelRuntime558HelpersClassCallCheck) {
            _classCallCheck = _npmBabelRuntime558HelpersClassCallCheck['default'];
        }],
        execute: function () {
            'use strict';

            marqueeCtrl = function marqueeCtrl($scope, $window, $interval, $rootScope) {
                _classCallCheck(this, marqueeCtrl);

                $scope.crono = {
                    marquesina: {
                        velocidad: 300,
                        texto: ''
                    },
                    command: {
                        slot: '      ',
                        mode: 0,
                        light: 'A',
                        points: '0'
                    },
                    _interval: null
                };

                $scope.$on('crono-ligth', function () {});

                $scope.submit = function () {

                    $scope.stop();
                    $scope.crono.marquesina.run = true;

                    var strlen = $scope.crono.marquesina.texto.length;
                    var current = 0;
                    var marquee = ' '.repeat(5) + $scope.crono.marquesina.texto.toUpperCase() + ' '.repeat(10) + ' '.repeat(5);

                    var interval = setInterval(function () {
                        $scope.$apply(function () {

                            $scope.crono.command.slot = marquee.substr(current, 6);

                            $scope.sendCommand([$scope.crono.command.light, $scope.crono.command.mode, $scope.crono.command.points, $scope.crono.command.slot].join(''));

                            if (current + 1 == marquee.length - 6) {
                                current = 0;
                            } else {
                                current++;
                            }
                        });
                    }, $scope.crono.marquesina.velocidad);

                    $scope.crono._interval = interval;
                };

                $scope.stop = function () {
                    clearInterval($scope.crono._interval);
                    $scope.crono.marquesina.run = false;
                };
            };

            _export('marqueeCtrl', marqueeCtrl);
        }
    };
});

//$scope.sendCommand($scope.crono.command.light + '4       ');
System.register('tabaCrono/controllers/crono', ['npm:babel-runtime@5.5.8/helpers/class-call-check'], function (_export) {
    var _classCallCheck, cronoCtrl;

    return {
        setters: [function (_npmBabelRuntime558HelpersClassCallCheck) {
            _classCallCheck = _npmBabelRuntime558HelpersClassCallCheck['default'];
        }],
        execute: function () {
            'use strict';

            cronoCtrl = function cronoCtrl($scope, $window, $interval) {
                _classCallCheck(this, cronoCtrl);

                console.log('test');
                $scope.showSubmenu = true;
                $scope.crono = {
                    automatico: true,
                    intencidad: 1,
                    command: {
                        slot: '      ',
                        mode: 1,
                        light: 'A',
                        points: '2'
                    },
                    started: false,
                    _interval: null,
                    time: {
                        hh: '00',
                        mm: '00',
                        ss: '00'
                    }
                };

                $scope.$on('crono-connect', function () {
                    $scope.$broadcast('crono-ligth');
                });

                var pad = function pad(i) {
                    var s = '' + i;
                    return s.length == 1 ? '0' + s : s;
                };

                $scope.$watch('crono.automatico', function (n) {
                    if (n) {
                        $scope.crono.command.light = 'A';
                    } else {
                        $scope.crono.command.light = $scope.crono.intencidad;
                    }
                    $scope.$broadcast('crono-ligth');
                });

                $scope.$watch('crono.intencidad', function (n) {
                    if (!$scope.crono.automatico) $scope.crono.command.light = n;
                    $scope.$broadcast('crono-ligth');
                });

                $scope.$on('crono-ligth', function () {});

                $scope.iniciar = function () {
                    $scope.crono.command.slot = [pad($scope.crono.time.hh), pad($scope.crono.time.mm), pad($scope.crono.time.ss)].join('');
                    $scope.sendCommand([$scope.crono.command.light, 1, $scope.crono.command.points, $scope.crono.command.slot].join(''));
                };

                var remote = require('remote');
                var fs = require('fs');
                var path = require('path');

                fs.writeFile(path.dirname(__root) + '/resultados.txt', '0', function (err) {
                    if (err) throw err;
                    console.log('It\'s saved!');
                });
            };

            _export('cronoCtrl', cronoCtrl);
        }
    };
});

//$scope.sendCommand($scope.crono.command.light + '4       ');
System.register("tabaCrono/controllers/countdown", ["npm:babel-runtime@5.5.8/helpers/class-call-check"], function (_export) {
  var _classCallCheck, countDownCtrl;

  return {
    setters: [function (_npmBabelRuntime558HelpersClassCallCheck) {
      _classCallCheck = _npmBabelRuntime558HelpersClassCallCheck["default"];
    }],
    execute: function () {
      "use strict";

      countDownCtrl = function countDownCtrl($scope, $timeout) {
        _classCallCheck(this, countDownCtrl);

        var timer;
        $scope.initTime = false;
        $scope.time = {
          hh: "00",
          mm: "00",
          ss: "00"
        };

        $scope.seconds = 0;

        var pad = function pad(i) {
          var s = "" + i;
          return s.length == 1 ? "0" + s : s;
        };

        $scope.start = function () {
          $scope.stop();
          $scope.seconds = $scope._getStartSeconds();
          timer = setInterval($scope._decrement, 1000);
        };

        $scope.stop = function () {
          clearInterval(timer);
        };

        $scope._decrement = function () {
          if ($scope.seconds === 0) {
            $scope.$broadcast("countdown-stop");
            return;
          }
          $scope.seconds--;

          if ($scope.seconds === 0) {
            $scope.isRefreshing = true;
          }
          $scope.$apply();

          $scope.$broadcast("countdown-emit", [$scope.seconds]);
        };

        $scope._getStartSeconds = function () {
          var startDateTime = moment();
          var endDateTime = moment().add(parseInt($scope.time.hh), "hours").add(parseInt($scope.time.mm), "minutes").add(parseInt($scope.time.ss), "seconds");

          var timeLeft = $scope.seconds = endDateTime.diff(startDateTime, "seconds", true);
          return Math.floor(timeLeft);
        };

        $scope.$on("countdown-stop", function () {
          $scope.stop();
        });

        $scope.$on("countdown-emit", function (seconds) {
          console.log($scope.seconds);
          var h = Math.floor($scope.seconds / 3600) % 24;
          var m = Math.floor($scope.seconds / 60) % 60;
          var s = $scope.seconds % 60;

          var str = ["A02", pad(h), pad(m), pad(s), "\r"].join("");
          console.log(str);
          $scope.sendCommand(str);
        });

        $scope.countDown = function () {
          var startDateTime = moment();
          var endDateTime = moment().add(parseInt($scope.time.hh), "hours").add(parseInt($scope.time.mm), "minutes").add(parseInt($scope.time.ss), "seconds");

          var timeLeft = $scope.seconds = endDateTime.diff(startDateTime, "seconds", true);

          var hours = Math.floor(moment.duration(timeLeft).asHours());

          endDateTime = endDateTime.subtract(hours, "hours");
          timeLeft = endDateTime.diff(startDateTime, "milliseconds", true);

          var minutes = Math.floor(moment.duration(timeLeft).asMinutes());

          endDateTime = endDateTime.subtract(minutes, "minutes");
          timeLeft = endDateTime.diff(startDateTime, "milliseconds", true);

          var seconds = Math.floor(moment.duration(timeLeft).asSeconds());
        };
      };

      _export("countDownCtrl", countDownCtrl);
    }
  };
});
System.register('tabaCrono/controllers/taba', ['npm:babel-runtime@5.5.8/helpers/class-call-check'], function (_export) {
    var _classCallCheck, tabaCtrl;

    return {
        setters: [function (_npmBabelRuntime558HelpersClassCallCheck) {
            _classCallCheck = _npmBabelRuntime558HelpersClassCallCheck['default'];
        }],
        execute: function () {
            'use strict';

            tabaCtrl = function tabaCtrl($scope, $rootScope, $timeout, $window, Flash) {
                _classCallCheck(this, tabaCtrl);

                $scope.app = $scope.tablero = $scope.msgs = {};
                $scope.semaforo = {};

                $scope.tablero.attemps = 0;
                $scope.tablero.maxAttemps = 2;
                $scope.tablero.ttAttemp = 20 * 60;
                $scope.tablero.connecting = false;
                $scope.tablero.errorConnection = false;
                $scope.tablero.connected = false;

                $scope.semaforo.attemps = 0;
                $scope.semaforo.maxAttemps = 2;
                $scope.semaforo.ttAttemp = 20 * 60;
                $scope.semaforo.connecting = false;
                $scope.semaforo.errorConnection = false;
                $scope.semaforo.connected = false;

                ipc.on('crono-status', function (status) {
                    $scope.$apply(function () {
                        if (status == 'connect') {
                            $scope.tablero.connected = true;
                            $scope.tablero.connecting = false;
                            $scope.tablero.errorConnection = false;
                            $scope.$broadcast('crono-connect');
                        } else {
                            $scope.tablero.connected = false;
                            $scope.$broadcast('crono-disconnect');
                        }
                    });
                });

                ipc.on('semaforo-status', function (status) {
                    $scope.$apply(function () {
                        if (status == 'connect') {
                            $scope.semaforo.connected = true;
                            $scope.semaforo.connecting = false;
                            $scope.semaforo.errorConnection = false;
                            $scope.$broadcast('semaforo-connect');
                        } else {
                            $scope.semaforo.connected = false;
                            $scope.$broadcast('semaforo-disconnect');
                        }
                    });
                });

                $scope.$on('semaforo-connect', function () {
                    Flash.create('success', 'conexion exitosa', 'customAlert');
                    //$scope.powerOn();
                });

                $scope.$on('crono-connect', function () {
                    Flash.create('success', 'conexion exitosa', 'customAlert');
                    //$scope.powerOn();
                });

                $scope.$on('semaforo-disconnect', function () {
                    Flash.create('warning', 'Semaforo desconectado', 'customAlert');
                    //$scope.powerOn();
                });

                $scope.$on('crono-disconnect', function () {
                    Flash.create('warning', 'Tablero desconectado', 'customAlert');
                    //$scope.powerOn();
                });

                ipc.on('crono-error', function (_trace) {
                    $scope.tablero.connecting = false;
                    $scope.$apply(function () {
                        $scope.tryConnect();
                    });
                });

                ipc.on('semaforo-error', function (_trace) {
                    $scope.tablero.connecting = false;
                    $scope.$apply(function () {
                        $scope.tryConnectSem();
                    });
                });

                $scope.tryConnect = function () {
                    if ($scope.tablero.attemps < $scope.tablero.maxAttemps) {
                        $scope.tablero.attemps++;
                        $scope.cronoConnect();
                    } else {
                        $scope.tablero.errorConnection = true;
                    }
                };

                $scope.tryConnectSem = function () {
                    if ($scope.semaforo.attemps < $scope.semaforo.maxAttemps) {
                        $scope.semaforo.attemps++;
                        $scope.semConnect();
                    } else {
                        $scope.semaforo.errorConnection = true;
                    }
                };

                $scope.resetAttemps = function (e) {
                    e.preventDefault();
                    if ($scope.tablero.attemps == $scope.tablero.maxAttemps) {
                        $scope.tablero.attemps = 0;
                        $scope.cronoConnect();
                    }
                };

                $scope.connectTo = function (ip) {
                    $scope.tablero.ip = ip;
                };

                $scope.cronoConnect = function () {
                    $scope.tablero.connecting = true;
                    $scope.tablero.errorConnection = false;
                    $scope.tablero.ip = $rootScope.config.ip || '192.168.1.15';
                    ipc.send('crono-connect', $scope.tablero.ip);
                };

                $scope.semConnect = function () {
                    ipc.send('semaforo-connect', $rootScope.config.semaforo_ip || '192.168.1.30');
                };

                $scope.sendCommand = function (command) {
                    console.log(command);
                    ipc.send('crono-send', command);
                };

                $scope.powerOff = function () {
                    ipc.send('crono-send', '012000000');
                    ipc.send('crono-send', '000      ');
                };

                $scope.powerOn = function () {
                    ipc.send('crono-send', 'A12000000');
                };

                $scope.disconnect = function () {
                    //$scope.powerOff();
                    ipc.send('crono-disconnect');
                };

                $scope.semDisconnect = function () {
                    ipc.send('semaforo-disconnect');
                };

                $scope['switch'] = function () {
                    if ($scope.tablero.connected) return $scope.disconnect();
                    return $scope.cronoConnect();
                };

                $scope.switchSem = function () {
                    if ($scope.semaforo.connected) return $scope.semDisconnect();
                    return $scope.semConnect();
                };

                $scope.msgSuccess = function (data) {
                    Flash.create('success', data);
                    console.log(data);
                };
            };

            _export('tabaCtrl', tabaCtrl);
        }
    };
});
System.register('tabaCrono/controllers/config', ['npm:babel-runtime@5.5.8/helpers/class-call-check'], function (_export) {
    var _classCallCheck, configCtrl;

    return {
        setters: [function (_npmBabelRuntime558HelpersClassCallCheck) {
            _classCallCheck = _npmBabelRuntime558HelpersClassCallCheck['default'];
        }],
        execute: function () {
            'use strict';

            configCtrl = function configCtrl($scope, $rootScope, $window) {
                _classCallCheck(this, configCtrl);

                $scope.data = {};

                if (typeof $rootScope.config !== 'undefined') $scope.data = $rootScope.config;

                $scope.save = function () {
                    $rootScope.config = $scope.data;
                    $window.localStorage.config = JSON.stringify($scope.data);
                };
            };

            _export('configCtrl', configCtrl);
        }
    };
});
System.register('tabaCrono/directives/taba/submenu', ['npm:babel-runtime@5.5.8/helpers/create-class', 'npm:babel-runtime@5.5.8/helpers/class-call-check'], function (_export) {
    var _createClass, _classCallCheck, tabaSubmenuDirective;

    return {
        setters: [function (_npmBabelRuntime558HelpersCreateClass) {
            _createClass = _npmBabelRuntime558HelpersCreateClass['default'];
        }, function (_npmBabelRuntime558HelpersClassCallCheck) {
            _classCallCheck = _npmBabelRuntime558HelpersClassCallCheck['default'];
        }],
        execute: function () {
            'use strict';

            tabaSubmenuDirective = (function () {
                function tabaSubmenuDirective() {
                    _classCallCheck(this, tabaSubmenuDirective);
                }

                _createClass(tabaSubmenuDirective, [{
                    key: 'menu',
                    value: function menu() {
                        return function () {
                            return {
                                restrict: 'A',
                                template: '<nav ng-if="showSubmenu" class="section menu"><ul><li ng-repeat="item in submenu"><a ng-href="{{item.url}}">{{item.name}}</a></li></ul></nav>',
                                link: function link(scope, element, attrs) {
                                    scope.submenu = 'hola';
                                }
                            };
                        };
                    }
                }]);

                return tabaSubmenuDirective;
            })();

            _export('tabaSubmenuDirective', tabaSubmenuDirective);
        }
    };
});
System.register('tabaCrono/app', ['github:angular/bower-angular@1.4.1', 'github:angular/bower-angular-route@1.4.1', 'github:angular/bower-angular-animate@1.4.1', 'github:sachinchoolur/angular-flash@1.1.0', 'github:moment/moment@2.10.3', 'tabaCrono/directives/taba/submenu', 'tabaCrono/controllers/text', 'tabaCrono/controllers/partidor', 'tabaCrono/controllers/marquee', 'tabaCrono/controllers/crono', 'tabaCrono/controllers/countdown', 'tabaCrono/controllers/taba', 'tabaCrono/controllers/config'], function (_export) {
    'use strict';

    var angular, moment, tabaSubmenuDirective, textCtrl, partidorCtrl, marqueeCtrl, cronoCtrl, countDownCtrl, tabaCtrl, configCtrl, app;
    return {
        setters: [function (_githubAngularBowerAngular141) {
            angular = _githubAngularBowerAngular141['default'];
        }, function (_githubAngularBowerAngularRoute141) {}, function (_githubAngularBowerAngularAnimate141) {}, function (_githubSachinchoolurAngularFlash110) {}, function (_githubMomentMoment2103) {
            moment = _githubMomentMoment2103['default'];
        }, function (_tabaCronoDirectivesTabaSubmenu) {
            tabaSubmenuDirective = _tabaCronoDirectivesTabaSubmenu.tabaSubmenuDirective;
        }, function (_tabaCronoControllersText) {
            textCtrl = _tabaCronoControllersText.textCtrl;
        }, function (_tabaCronoControllersPartidor) {
            partidorCtrl = _tabaCronoControllersPartidor.partidorCtrl;
        }, function (_tabaCronoControllersMarquee) {
            marqueeCtrl = _tabaCronoControllersMarquee.marqueeCtrl;
        }, function (_tabaCronoControllersCrono) {
            cronoCtrl = _tabaCronoControllersCrono.cronoCtrl;
        }, function (_tabaCronoControllersCountdown) {
            countDownCtrl = _tabaCronoControllersCountdown.countDownCtrl;
        }, function (_tabaCronoControllersTaba) {
            tabaCtrl = _tabaCronoControllersTaba.tabaCtrl;
        }, function (_tabaCronoControllersConfig) {
            configCtrl = _tabaCronoControllersConfig.configCtrl;
        }],
        execute: function () {
            app = angular.module('TabaCrono', ['ngRoute', 'flash', 'ngAnimate']);

            app.config(function ($routeProvider) {
                $routeProvider.when('/', {
                    templateUrl: 'views/home.html',
                    controller: 'cronoCtrl'
                }).when('/countdown', {
                    templateUrl: 'views/countdown.html',
                    controller: 'countDownCtrl'
                }).when('/marquesina', {
                    templateUrl: 'views/marquesina.html',
                    controller: 'marqueeCtrl'
                }).when('/texto', {
                    templateUrl: 'views/texto.html',
                    controller: 'textCtrl'
                }).when('/partidor', {
                    templateUrl: 'views/partidor.html',
                    controller: 'partidorCtrl'
                }).when('/configuracion', {
                    templateUrl: 'views/config.html',
                    controller: 'configCtrl'
                }).otherwise({
                    redirectTo: '/'
                });
            });

            app.run(function ($rootScope, $window) {
                $rootScope._intervals = [];

                if (typeof $window.localStorage.config != 'undefined') {
                    $rootScope.config = JSON.parse($window.localStorage.config);
                }

                $rootScope.$on('$routeChangeSuccess', function (newVal, oldVal) {
                    angular.forEach($rootScope._intervals, function (_interval) {
                        clearInterval(_interval);
                    });
                });
            });

            app.controller('tabaCtrl', tabaCtrl);
            app.controller('cronoCtrl', cronoCtrl);
            app.controller('countDownCtrl', countDownCtrl);
            app.controller('textCtrl', textCtrl);
            app.controller('partidorCtrl', partidorCtrl);
            app.controller('marqueeCtrl', marqueeCtrl);
            app.controller('configCtrl', configCtrl);

            app.directive('tabaSubmenu', function () {
                return {
                    restrict: 'A',
                    template: '<nav ng-if="showSubmenu"><ul><li>Menu para la seccion: <li ng-repeat="item in submenu"><a ng-href="{{item.url}}">{{item.name}}</a></li></ul></nav>'
                };
            });

            app.directive('tabaRemoveLoadingReady', function () {
                return {
                    restrict: 'A',
                    link: function link(scope, element, attrs) {
                        element.removeClass('loading');
                        element.removeClass('segment');
                        element.removeClass('ui');
                    }
                };
            });
            app.directive('tabaRemoveHiddenReady', function () {
                return {
                    restrict: 'A',
                    link: function link(scope, element, attrs) {
                        element.removeClass('taba-hidden');
                    }
                };
            });

            app.filter('tabaOnOf', function (val) {
                if (!val) return 'Conectar';
                return 'Desconectar';
            });

            app.filter('tabaOnOf', function () {
                return function (val) {
                    if (!val) return 'Conectar';
                    return 'Desconectar';
                };
            });

            app.filter('tabaOnOfClass', function () {
                return function (val) {
                    if (!val) return 'green';
                    return 'red';
                };
            });

            app.filter('uiGrid', function () {
                return function (column) {
                    var name = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen'];

                    if (typeof name[column] !== 'undefined') return name[column];
                    return name[name.length - 1];
                };
            });

            app.filter('HMMSS', ['$filter', function ($filter) {
                return function (input, decimals) {
                    var sec_num = parseInt(input, 10),
                        decimal = parseFloat(input) - sec_num,
                        hours = Math.floor(sec_num / 3600),
                        minutes = Math.floor((sec_num - hours * 3600) / 60),
                        seconds = sec_num - hours * 3600 - minutes * 60;

                    if (hours < 10) {
                        hours = '0' + hours;
                    }
                    if (minutes < 10) {
                        minutes = '0' + minutes;
                    }
                    if (seconds < 10) {
                        seconds = '0' + seconds;
                    }
                    var time = hours + ':' + minutes + ':' + seconds;
                    if (decimals > 0) {
                        time += '.' + $filter('number')(decimal, decimals).substr(2);
                    }
                    return time;
                };
            }]);
        }
    };
});
(function() {
  var loader = System;
  if (typeof indexOf == 'undefined')
    indexOf = Array.prototype.indexOf;

  function readGlobalProperty(p, value) {
    var pParts = p.split('.');
    while (pParts.length)
      value = value[pParts.shift()];
    return value;
  }

  var ignoredGlobalProps = ['sessionStorage', 'localStorage', 'clipboardData', 'frames', 'external'];

  var hasOwnProperty = loader.global.hasOwnProperty;

  function iterateGlobals(callback) {
    if (Object.keys)
      Object.keys(loader.global).forEach(callback);
    else
      for (var g in loader.global) {
        if (!hasOwnProperty.call(loader.global, g))
          continue;
        callback(g);
      }
  }

  function forEachGlobal(callback) {
    iterateGlobals(function(globalName) {
      if (indexOf.call(ignoredGlobalProps, globalName) != -1)
        return;
      try {
        var value = loader.global[globalName];
      }
      catch(e) {
        ignoredGlobalProps.push(globalName);
      }
      callback(globalName, value);
    });
  }

  var moduleGlobals = {};

  var globalSnapshot;

  loader.set('@@global-helpers', loader.newModule({
    prepareGlobal: function(moduleName, deps) {
      // first, we add all the dependency modules to the global
      for (var i = 0; i < deps.length; i++) {
        var moduleGlobal = moduleGlobals[deps[i]];
        if (moduleGlobal)
          for (var m in moduleGlobal)
            loader.global[m] = moduleGlobal[m];
      }

      // now store a complete copy of the global object
      // in order to detect changes
      globalSnapshot = {};
      
      forEachGlobal(function(name, value) {
        globalSnapshot[name] = value;
      });
    },
    retrieveGlobal: function(moduleName, exportName, init) {
      var singleGlobal;
      var multipleExports;
      var exports = {};

      // run init
      if (init)
        singleGlobal = init.call(loader.global);

      // check for global changes, creating the globalObject for the module
      // if many globals, then a module object for those is created
      // if one global, then that is the module directly
      else if (exportName) {
        var firstPart = exportName.split('.')[0];
        singleGlobal = readGlobalProperty(exportName, loader.global);
        exports[firstPart] = loader.global[firstPart];
      }

      else {
        forEachGlobal(function(name, value) {
          if (globalSnapshot[name] === value)
            return;
          if (typeof value === 'undefined')
            return;
          exports[name] = value;
          if (typeof singleGlobal !== 'undefined') {
            if (!multipleExports && singleGlobal !== value)
              multipleExports = true;
          }
          else {
            singleGlobal = value;
          }
        });
      }

      moduleGlobals[moduleName] = exports;

      return multipleExports ? exports : singleGlobal;
    }
  }));
})();
});
//# sourceMappingURL=pack.js.map