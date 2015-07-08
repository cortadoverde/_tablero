System.config({
  "baseURL": "C:\\Users\\SamudiaP\\AppData\\Roaming\\npm\\node_modules\\jspm\\lib\\config/",
  "transpiler": "babel",
  "babelOptions": {
    "optional": [
      "runtime"
    ]
  },
  "paths": {
    "*": "*.js",
    "github:*": "jspm_packages/github/*.js",
    "npm:*": "jspm_packages/npm/*.js"
  }
});

System.config({
  "map": {
    "angular": "github:angular/bower-angular@1.4.1",
    "angular-animate": "github:angular/bower-angular-animate@1.4.1",
    "angular-route": "github:angular/bower-angular-route@1.4.1",
    "babel": "npm:babel-core@5.5.8",
    "babel-runtime": "npm:babel-runtime@5.5.8",
    "core-js": "npm:core-js@0.9.17",
    "gtramontina/angular-flash": "github:gtramontina/angular-flash@1.2.0",
    "likeastore/ngDialog": "github:likeastore/ngDialog@0.4.0",
    "mateu-aguilo-bosch/message-center": "github:mateu-aguilo-bosch/message-center@1.1.4",
    "moment": "github:moment/moment@2.10.3",
    "sachinchoolur/angular-flash": "github:sachinchoolur/angular-flash@1.1.0",
    "wmluke/angular-flash": "github:wmluke/angular-flash@0.1.14",
    "github:angular/bower-angular-animate@1.4.1": {
      "angular": "github:angular/bower-angular@1.4.1"
    },
    "github:angular/bower-angular-route@1.4.1": {
      "angular": "github:angular/bower-angular@1.4.1"
    },
    "github:jspm/nodelibs-process@0.1.1": {
      "process": "npm:process@0.10.1"
    },
    "npm:babel-runtime@5.5.8": {
      "process": "github:jspm/nodelibs-process@0.1.1"
    },
    "npm:core-js@0.9.17": {
      "fs": "github:jspm/nodelibs-fs@0.1.2",
      "process": "github:jspm/nodelibs-process@0.1.1",
      "systemjs-json": "github:systemjs/plugin-json@0.1.0"
    }
  }
});

