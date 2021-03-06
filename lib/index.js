var Sequelize = require('sequelize');
var async = require('async');
var fs = require('graceful-fs-extra');
var path = require('path');
var mkdirp = require('mkdirp');
var dialects = require('./dialects');
var _ = require('lodash');
var SqlString = require('./sql-string');
var tsHelper = require('./ts-helper');
var CLIEngine = require('eslint').CLIEngine;

function AutoSequelize(database, username, password, options) {
  if (options && options.dialect === 'sqlite' && ! options.storage)
    options.storage = database;

  if (database instanceof Sequelize) {
    this.sequelize = database;
  } else {
    this.sequelize = new Sequelize(database, username, password, options || {});
  }

  this.queryInterface = this.sequelize.getQueryInterface();
  this.tables = {};
  this.foreignKeys = {};
  this.dialect = dialects[this.sequelize.options.dialect];

  this.options = _.extend({
    global: 'Sequelize',
    local: 'sequelize',
    spaces: false,
    indentation: 1,
    directory: './models',
    additional: {},
    freezeTableName: true,
    typescript: false
  }, options || {});
}

AutoSequelize.prototype.build = function(callback) {
  var self = this;

  function mapTable(table, _callback){
    self.queryInterface.describeTable(table, self.options.schema).then(function(fields) {
      self.tables[table] = fields
      _callback();
    }, _callback);
  }

  if (self.options.dialect === 'postgres' && self.options.schema) {
    var showTablesSql = this.dialect.showTablesQuery(self.options.schema);
    self.sequelize.query(showTablesSql, {
      raw: true,
      type: self.sequelize.QueryTypes.SHOWTABLES
    }).then(function(tableNames) {
      processTables(_.flatten(tableNames))
    }, callback);
  } else {
    this.queryInterface.showAllTables().then(processTables, callback);
  }

  function processTables(__tables) {
    if (self.sequelize.options.dialect === 'mssql')
      __tables = _.map(__tables, 'tableName');

    var tables;

    if      (self.options.tables)     tables = _.intersection(__tables, self.options.tables)
    else if (self.options.skipTables) tables = _.difference  (__tables, self.options.skipTables)
    else                              tables = __tables

    async.each(tables, mapForeignKeys, mapTables);

    function mapTables(err) {
      if (err) console.error(err)

      async.each(tables, mapTable, callback);
    }
  }

  function mapForeignKeys(table, fn) {
    if (! self.dialect) return fn()

    var sql = self.dialect.getForeignKeysQuery(table, self.sequelize.config.database)

    self.sequelize.query(sql, {
      type: self.sequelize.QueryTypes.SELECT,
      raw: true
    }).then(function (res) {
      _.each(res, assignColumnDetails)
      fn()
    }, fn);

    function assignColumnDetails(ref) {
      // map sqlite's PRAGMA results
      ref = _.mapKeys(ref, function (value, key) {
        switch (key) {
        case 'from':
          return 'source_column';
        case 'to':
          return 'target_column';
        case 'table':
          return 'target_table';
        default:
          return key;
        }
      });

      ref = _.assign({
        source_table: table,
        source_schema: self.sequelize.options.database,
        target_schema: self.sequelize.options.database
      }, ref);

      if (! _.isEmpty(_.trim(ref.source_column)) && ! _.isEmpty(_.trim(ref.target_column))) {
        ref.isForeignKey = true
        ref.foreignSources = _.pick(ref, ['source_table', 'source_schema', 'target_schema', 'target_table', 'source_column', 'target_column'])
      }

      if (_.isFunction(self.dialect.isUnique) && self.dialect.isUnique(ref))
        ref.isUnique = true

      if (_.isFunction(self.dialect.isPrimaryKey) && self.dialect.isPrimaryKey(ref))
        ref.isPrimaryKey = true

       if (_.isFunction(self.dialect.isSerialKey) && self.dialect.isSerialKey(ref))
         ref.isSerialKey = true

      self.foreignKeys[table] = self.foreignKeys[table] || {};
      self.foreignKeys[table][ref.source_column] = _.assign({}, self.foreignKeys[table][ref.source_column], ref);
    }
  }
}

AutoSequelize.prototype.runGrao = function(callback) {
  var self = this;
  var text = {};
  var tables = [];
  var typescriptFiles = [self.options.typescript ? tsHelper.def.getDefinitionFileStart() : '', ''];
  var tsTableNames = [];

  this.build(generateText);

  function generateText(err) {
    var quoteWrapper = '"';
    if (err) console.error(err)

    async.each(_.keys(self.tables), function(table, _callback){
      var fields = _.keys(self.tables[table])
        , spaces = '';

      for (var x = 0; x < self.options.indentation; ++x) {
        spaces += (self.options.spaces === true ? ' ' : "\t");
      }

      var tableName = self.options.camelCase ? _.camelCase(table) : table;
      var tsTableDef = self.options.typescript ? 'export interface ' + tableName + 'Attribute {' : '';

      if(!self.options.typescript){
        text[table] = '{\n  "bundle": "'+tableName+'",\n  "label": "'+self.capitalize(tableName).replace("_", " ")+
                      '",\n  "description": "All '+self.capitalize(tableName).replace("_"," ")+'",\n  "refLabel": "",\n  "fields": {\n';
      } else {
        tsTableNames.push(tableName);
        text[table] = tsHelper.model.getModelFileStart(self.options.indentation, spaces, tableName);
      }

      _.each(fields, function(field, i){
          var additional = self.options.additional
          if( additional && additional.timestamps !== undefined && additional.timestamps){
            if((additional.createdAt && field === 'createdAt' || additional.createdAt === field )
              ||(additional.updatedAt && field === 'updatedAt' || additional.updatedAt === field )
              ||(additional.deletedAt && field === 'deletedAt' || additional.deletedAt === field )){
              return true
            }
          }
        // Find foreign key
        var foreignKey = self.foreignKeys[table] && self.foreignKeys[table][field] ? self.foreignKeys[table][field] : null

        if (_.isObject(foreignKey)) {
          self.tables[table][field].foreignKey = foreignKey
        }

        // column's attributes
        var fieldAttr = _.keys(self.tables[table][field]);
        var fieldName = self.options.camelCase ? _.camelCase(field) : field;
        text[table] += spaces + spaces + '"'+fieldName+'"'+ ": {\n";
        text[table] += spaces + spaces + spaces + '"label": '+'"'+self.capitalize(fieldName).replace("_"," ")+'",\n';
        text[table] += spaces + spaces + spaces + '"isList": true,\n';
        text[table] += spaces + spaces + spaces + '"isFilter": true,\n';

        // Serial key for postgres...
        var defaultVal = self.tables[table][field].defaultValue;

        // ENUMs for postgres...
        if (self.tables[table][field].type === "USER-DEFINED" && !! self.tables[table][field].special) {
          self.tables[table][field].type = "ENUM(" + self.tables[table][field].special.map(function(f){ return quoteWrapper + f + quoteWrapper; }).join(',') + ")";
        }

        // typescript
        var tsAllowNull = '';
        var tsVal = '';

        var isUnique = self.tables[table][field].foreignKey && self.tables[table][field].foreignKey.isUnique

        _.each(fieldAttr, function(attr, x){
          var isSerialKey = self.tables[table][field].foreignKey && _.isFunction(self.dialect.isSerialKey) && self.dialect.isSerialKey(self.tables[table][field].foreignKey)

          // We don't need the special attribute from postgresql describe table..
          if (attr === "special") {
            return true;
          }

          if (attr === "foreignKey") {
            if (isSerialKey) {
              //text[table] += spaces + spaces + spaces + "autoIncrement: true";
            }
            else if (foreignKey.isForeignKey) {
              if(self.tables[table][field]['primaryKey'] == false && self.tables[table][field]['foreignKey']) {
                text[table] += ",";
                text[table] += "\n";
              }
              text[table] += spaces + spaces + spaces + '"type": "select",\n';
              text[table] += spaces + spaces + spaces + '"ref": "'+self.capitalize(self.tables[table][field][attr].foreignSources.target_table.replace(/[^a-zA-Z0-9_]+/,""))+'"';
              //text[table] += spaces + spaces + spaces + spaces + "model: \'" + self.tables[table][field][attr].foreignSources.target_table + "\',\n"
              //text[table] += spaces + spaces + spaces + spaces + "key: \'" + self.tables[table][field][attr].foreignSources.target_column + "\'\n"
              //text[table] += spaces + spaces + spaces + "}"
            } else return true
          }
          else if (attr === "primaryKey") {
            var _attr = (self.tables[table][field]["type"] || '').toLowerCase();
            if (self.tables[table][field][attr] === true && 
                _attr.match(/^(smallint|mediumint|tinyint|int|bigint|long)/) && 
                (! _.has(self.tables[table][field], 'foreignKey') || (_.has(self.tables[table][field], 'foreignKey') && !! self.tables[table][field].foreignKey.isPrimaryKey)))
            {
                if(self.tables[table][field]['foreignKey'] && self.tables[table][field]['foreignKey'].isForeignKey == true)
                  return true;
                else
                  text[table] += spaces + spaces + spaces + '"type": "primary"';
            } else {
              return true;
            }
          }
          else if (attr === "allowNull" && self.tables[table][field]['primaryKey'] == false) {
            text[table] += spaces + spaces + spaces + '"required": ' + !self.tables[table][field][attr];
            if(self.options.typescript) tsAllowNull = self.tables[table][field][attr];
          }
          else if (attr === "defaultValue") {
            if (self.sequelize.options.dialect === "mssql" &&  defaultVal && defaultVal.toLowerCase() === '(newid())') {
              defaultVal = null; // disable adding "default value" attribute for UUID fields if generating for MS SQL
            }

            var val_text = defaultVal;

            if (isSerialKey) return true

            //mySql Bit fix
            if (self.tables[table][field].type.toLowerCase() === 'bit(1)') {
              val_text = defaultVal === "b'1'" ? 1 : 0;
            }
            // mssql bit fix
            else if (self.sequelize.options.dialect === "mssql" && self.tables[table][field].type.toLowerCase() === "bit") {
              val_text = defaultVal === "((1))" ? 1 : 0;
            }

            if (_.isString(defaultVal)) {
              var field_type = self.tables[table][field].type.toLowerCase();
              if (_.endsWith(defaultVal, '()')) {
                val_text = "sequelize.fn('" + defaultVal.replace(/\(\)$/, '') + "')"
              }
              else if (field_type.indexOf('date') === 0 || field_type.indexOf('timestamp') === 0) {
                 if (_.includes(['current_timestamp', 'current_date', 'current_time', 'localtime', 'localtimestamp'], defaultVal.toLowerCase())) {
                  val_text = "sequelize.literal('" + defaultVal + "')"
                } else {
                  val_text = quoteWrapper + val_text + quoteWrapper
                }
              } else {
                val_text = quoteWrapper + val_text + quoteWrapper
              }
            }

            if(defaultVal === null || defaultVal === undefined) {
              return true;
            } else {
              val_text = _.isString(val_text) && !val_text.match(/^sequelize\.[^(]+\(.*\)$/) ? SqlString.escape(_.trim(val_text, '"'), null, self.options.dialect) : val_text;

              // don't prepend N for MSSQL when building models...
              val_text = _.trimStart(val_text, 'N')
              //text[table] += spaces + spaces + spaces + attr + ": " + val_text;
            }
          }
          else if (attr === "type" && self.tables[table][field][attr].indexOf('ENUM') === 0) {
            text[table] += spaces + spaces + spaces + '"type": "select",\n';
            var options = self.tables[table][field][attr].replace("ENUM(", "");
            options = options.replace(")","");
            options = options.replace(/'/g,"");
            options = options.split(",");
            var newOptions = [];
            options.forEach(function(e, i, a){
              newOptions.push('"'+e+'": "'+e+'"');
            });
            newOptions = newOptions.join(",");
            text[table] += spaces + spaces + spaces + '"options": {'+newOptions+'}';
          } else if (attr === "type" && self.tables[table][field][attr].indexOf('SET') === 0) {
            text[table] += spaces + spaces + spaces + '"type": "select",\n';
            var options = self.tables[table][field][attr].replace("SET(", "");
            
            options = options.replace(")","");
            options = options.replace(/'/g,"");
            options = options.split(",");
            var newOptions = [];
            options.forEach(function(e, i, a){
              newOptions.push('"'+e+'": "'+e+'"');
            });
            newOptions = newOptions.join(",");
            text[table] += spaces + spaces + spaces + '"options": {'+newOptions+'}';
          } else {
            var _attr = (self.tables[table][field][attr] || '').toLowerCase();
            var val = quoteWrapper + self.tables[table][field][attr] + quoteWrapper;

            if (_attr === "boolean" || _attr === "bit(1)" || _attr === "bit" || _attr === "tinyint(1)") {
              val = 'boolean';
            }
            else if (_attr.match(/^(smallint|mediumint|tinyint|int)/)) {
              var length = _attr.match(/\(\d+\)/);
              val = 'number';
            }
            else if (_attr.match(/^bigint/)) {
              val = 'number';
            }
            else if (_attr.match(/^varchar/)) {
              var length = _attr.match(/\(\d+\)/);
              val = 'text';
            }
            else if (_attr.match(/^string|varying|nvarchar/)) {
              val = 'text';
            }
            else if (_attr.match(/^char/)) {
              var length = _attr.match(/\(\d+\)/);
              val = 'text';
            }
            else if (_attr.match(/^real/)) {
              val = 'number';
            }
            else if (_attr.match(/text|ntext$/)) {
              val = 'textarea';
            }
            else if (_attr.match(/^(date|timestamp)/)) {
              val = 'date';
            }
            else if (_attr.match(/^(time)/)) {
              val = 'date';
            }
            else if (_attr.match(/^(float|float4)/)) {
              val = 'number';
            }
            else if (_attr.match(/^decimal/)) {
              val = 'number';
            }
            else if (_attr.match(/^(float8|double precision|numeric)/)) {
              val = 'number';
            }
            else if (_attr.match(/^uuid|uniqueidentifier/)) {
              val = 'text';
            }
            else if (_attr.match(/^jsonb/)) {
              val = 'textarea';
            }
            else if (_attr.match(/^json/)) {
              val = 'textarea';
            }
            else if (_attr.match(/^geometry/)) {
              val = 'text';
            }
            if(self.tables[table][field]['primaryKey'] == false || val == "text" || val == "textarea") {
              if(!self.tables[table][field]['foreignKey'])
                text[table] += spaces + spaces + spaces + '"'+attr+'"' + ': ' + '"'+val+'"';
            }
            if(self.options.typescript) tsVal = val;
          }

          if(self.tables[table][field]['primaryKey'] == false && !self.tables[table][field]['foreignKey']) {
            if(attr != "defaultValue")
              text[table] += ",";
            text[table] += "\n";  
          }
          
        });

        if (isUnique) {
          text[table] += spaces + spaces + spaces + '"unique": true,\n';
        }

        if (self.options.camelCase) {
          text[table] += spaces + spaces + spaces + "field: '" + field + "',\n";
        }

        // removes the last `,` within the attribute options
        text[table] = text[table].trim().replace(/,+$/, '') + "\n";

        text[table] += spaces + spaces + "}";
        if ((i+1) < fields.length) {
          text[table] += ",";
        }
        text[table] += "\n";

        // typescript, get definition for this field
        if(self.options.typescript) tsTableDef += tsHelper.def.getMemberDefinition(spaces, fieldName, tsVal, tsAllowNull);
      });

      text[table] += spaces + "}";

      //conditionally add additional options to tag on to orm objects
      var hasadditional = _.isObject(self.options.additional) && _.keys(self.options.additional).length > 0;

      //text[table] += ", {\n";

      //text[table] += spaces + spaces  + "tableName: '" + table + "',\n";

      if (hasadditional) {
        _.each(self.options.additional, addAdditionalOption)
      }

      text[table] = text[table].trim()
      text[table] = text[table].substring(0, text[table].length - 1);
      text[table] += "\n" + spaces + "}";

      // typescript end table in definitions file
      if(self.options.typescript) typescriptFiles[0] += tsHelper.def.getTableDefinition(tsTableDef, tableName);
      
      function addAdditionalOption(value, key) {
        if (key === 'name') {
          // name: true - preserve table name always
          text[table] += spaces + spaces + "name: {\n";
          text[table] += spaces + spaces + spaces + "singular: '" + table + "',\n";
          text[table] += spaces + spaces + spaces + "plural: '" + table + "'\n";
          text[table] += spaces + spaces + "},\n";
        }
        else {
          value = _.isBoolean(value)?value:("'"+value+"'")
          text[table] += spaces + spaces + key + ": " + value + ",\n";
        }
      }

      //resume normal output
      //text[table] += ");\n};\n";
      text[table] += "\n}";
      _callback(null);
    }, function(){
      self.sequelize.close();
      
      // typescript generate tables
      if(self.options.typescript) typescriptFiles[1] = tsHelper.model.generateTableModels(tsTableNames, self.options.spaces, self.options.indentation);

      if (self.options.directory) {
        return self.write(text, typescriptFiles, callback);
      }
      return callback(false, text);
    });
  }
}

AutoSequelize.prototype.normalizeTableName = function(tableName) {
  self = this
  let tableName2 = tableName.split("_")
  tableName2.shift()
  for(let k in tableName2) {
    tableName2[k] = self.capitalize(tableName2[k])
  }
  tableName2 = tableName2.join("")
  return tableName2
}

AutoSequelize.prototype.runGraphqlSchemas = function(callback) {
  var self = this;
  var text = {};
  var tables = [];
  var tablesAttrs = {};
  var typescriptFiles = [self.options.typescript ? tsHelper.def.getDefinitionFileStart() : '', ''];
  var tsTableNames = [];

  this.build(generateText);

  function generateText(err) {
    var quoteWrapper = '"';
    if (err) console.error(err)

    async.each(_.keys(self.tables), function(table, _callback){
      var fields = _.keys(self.tables[table])
        , spaces = '';

      for (var x = 0; x < self.options.indentation; ++x) {
        spaces += (self.options.spaces === true ? ' ' : "\t");
      }

      var tableName = self.options.camelCase ? _.camelCase(table) : table;
      var tsTableDef = self.options.typescript ? 'export interface ' + tableName + 'Attribute {' : '';

      if(!self.options.typescript){
        
        text[table] = 'type '+self.normalizeTableName(tableName)+" {\n"
      } else {
        tsTableNames.push(tableName);
        text[table] = tsHelper.model.getModelFileStart(self.options.indentation, spaces, tableName);
      }
      tablesAttrs[table] = []
      _.each(fields, function(field, i){
          var additional = self.options.additional
          if( additional && additional.timestamps !== undefined && additional.timestamps){
            if((additional.createdAt && field === 'createdAt' || additional.createdAt === field )
              ||(additional.updatedAt && field === 'updatedAt' || additional.updatedAt === field )
              ||(additional.deletedAt && field === 'deletedAt' || additional.deletedAt === field )){
              return true
            }
          }
        // Find foreign key
        var foreignKey = self.foreignKeys[table] && self.foreignKeys[table][field] ? self.foreignKeys[table][field] : null

        if (_.isObject(foreignKey)) {
          self.tables[table][field].foreignKey = foreignKey
        }

        // column's attributes
        var fieldAttr = _.keys(self.tables[table][field]);
        var fieldName = self.options.camelCase ? _.camelCase(field) : field;
        text[table] += spaces + spaces + fieldName + ": "+(fieldName.toUpperCase() == "ID" ? "ID!" : fieldName)+"\n";

        // Serial key for postgres...
        var defaultVal = self.tables[table][field].defaultValue;

        // ENUMs for postgres...
        if (self.tables[table][field].type === "USER-DEFINED" && !! self.tables[table][field].special) {
          self.tables[table][field].type = "ENUM(" + self.tables[table][field].special.map(function(f){ return quoteWrapper + f + quoteWrapper; }).join(',') + ")";
        }

        // typescript
        var tsAllowNull = '';
        var isAllowNull = false;
        var tsVal = '';

        var isUnique = self.tables[table][field].foreignKey && self.tables[table][field].foreignKey.isUnique

        for(let k in fieldAttr) {
          let attr = fieldAttr[k]
          if (attr === "allowNull" && self.tables[table][field]['primaryKey'] == false) isAllowNull = true;
        }

        _.each(fieldAttr, function(attr, x){
          var isSerialKey = self.tables[table][field].foreignKey && _.isFunction(self.dialect.isSerialKey) && self.dialect.isSerialKey(self.tables[table][field].foreignKey)

          // We don't need the special attribute from postgresql describe table..
          if (attr === "special") {
            return true;
          }

          if (attr === "foreignKey") {
            if (isSerialKey) {
            } else if (foreignKey.isForeignKey) {
              if(self.tables[table][field]['primaryKey'] == false && self.tables[table][field]['foreignKey']) {
                text[table] = text[table].replace(": "+fieldName, ": ID"+(isAllowNull ? "" : "!"))
              }
            } else return true
          }
          else if (attr === "primaryKey") {
            var _attr = (self.tables[table][field]["type"] || '').toLowerCase();
            if (self.tables[table][field][attr] === true && 
                _attr.match(/^(smallint|mediumint|tinyint|int|bigint|long)/) && 
                (! _.has(self.tables[table][field], 'foreignKey') || (_.has(self.tables[table][field], 'foreignKey') && !! self.tables[table][field].foreignKey.isPrimaryKey)))
            {
                if(self.tables[table][field]['foreignKey'] && self.tables[table][field]['foreignKey'].isForeignKey == true)
                  return true;
            } else {
              return true;
            }
          }
          else if (attr === "allowNull" && self.tables[table][field]['primaryKey'] == false) {
            if(self.options.typescript) tsAllowNull = self.tables[table][field][attr];
          }
          else if (attr === "defaultValue") {
            if (self.sequelize.options.dialect === "mssql" &&  defaultVal && defaultVal.toLowerCase() === '(newid())') {
              defaultVal = null; // disable adding "default value" attribute for UUID fields if generating for MS SQL
            }

            var val_text = defaultVal;

            if (isSerialKey) return true

            //mySql Bit fix
            if (self.tables[table][field].type.toLowerCase() === 'bit(1)') {
              val_text = defaultVal === "b'1'" ? 1 : 0;
            }
            // mssql bit fix
            else if (self.sequelize.options.dialect === "mssql" && self.tables[table][field].type.toLowerCase() === "bit") {
              val_text = defaultVal === "((1))" ? 1 : 0;
            }

            if (_.isString(defaultVal)) {
              var field_type = self.tables[table][field].type.toLowerCase();
              if (_.endsWith(defaultVal, '()')) {
                val_text = "sequelize.fn('" + defaultVal.replace(/\(\)$/, '') + "')"
              }
              else if (field_type.indexOf('date') === 0 || field_type.indexOf('timestamp') === 0) {
                 if (_.includes(['current_timestamp', 'current_date', 'current_time', 'localtime', 'localtimestamp'], defaultVal.toLowerCase())) {
                  val_text = "sequelize.literal('" + defaultVal + "')"
                } else {
                  val_text = quoteWrapper + val_text + quoteWrapper
                }
              } else {
                val_text = quoteWrapper + val_text + quoteWrapper
              }
            }

            if(defaultVal === null || defaultVal === undefined) {
              return true;
            } else {
              val_text = _.isString(val_text) && !val_text.match(/^sequelize\.[^(]+\(.*\)$/) ? SqlString.escape(_.trim(val_text, '"'), null, self.options.dialect) : val_text;

              // don't prepend N for MSSQL when building models...
              val_text = _.trimStart(val_text, 'N')
            }
          }
          else if (attr === "type" && self.tables[table][field][attr].indexOf('ENUM') === 0) {
            var options = self.tables[table][field][attr].replace("ENUM(", "");
            options = options.replace(")","");
            options = options.replace(/'/g,"");
            options = options.split(",");
            var newOptions = [];
            options.forEach(function(e, i, a){
              newOptions.push('"'+e+'": "'+e+'"');
            });
            newOptions = newOptions.join(",");
          } else if (attr === "type" && self.tables[table][field][attr].indexOf('SET') === 0) {
            var options = self.tables[table][field][attr].replace("SET(", "");
            
            options = options.replace(")","");
            options = options.replace(/'/g,"");
            options = options.split(",");
            var newOptions = [];
            options.forEach(function(e, i, a){
              newOptions.push('"'+e+'": "'+e+'"');
            });
            newOptions = newOptions.join(",");
          } else {
            var _attr = (self.tables[table][field][attr] || '').toLowerCase();
            var val = quoteWrapper + self.tables[table][field][attr] + quoteWrapper;

            if (_attr === "boolean" || _attr === "bit(1)" || _attr === "bit" || _attr === "tinyint(1)") {
              val = 'Boolean';
            }
            else if (_attr.match(/^(smallint|mediumint|tinyint|int)/)) {
              var length = _attr.match(/\(\d+\)/);
              val = 'Int';
            }
            else if (_attr.match(/^bigint/)) {
              val = 'Int';
            }
            else if (_attr.match(/^varchar/)) {
              var length = _attr.match(/\(\d+\)/);
              val = 'String';
            }
            else if (_attr.match(/^string|varying|nvarchar/)) {
              val = 'String';
            }
            else if (_attr.match(/^char/)) {
              var length = _attr.match(/\(\d+\)/);
              val = 'String';
            }
            else if (_attr.match(/^real/)) {
              val = 'String';
            }
            else if (_attr.match(/text|ntext$/)) {
              val = 'String';
            }
            else if (_attr.match(/^(date|timestamp)/)) {
              val = 'String';
            }
            else if (_attr.match(/^(time)/)) {
              val = 'String';
            }
            else if (_attr.match(/^(float|float4)/)) {
              val = 'String';
            }
            else if (_attr.match(/^decimal/)) {
              val = 'String';
            }
            else if (_attr.match(/^(float8|double precision|numeric)/)) {
              val = 'String';
            }
            else if (_attr.match(/^uuid|uniqueidentifier/)) {
              val = 'String';
            }
            else if (_attr.match(/^jsonb/)) {
              val = 'String';
            }
            else if (_attr.match(/^json/)) {
              val = 'String';
            }
            else if (_attr.match(/^geometry/)) {
              val = 'String';
            }
            if(self.tables[table][field]['primaryKey'] == false || val == "text" || val == "textarea") {
              if(!self.tables[table][field]['foreignKey'] && fieldName.toUpperCase() != "ID") {
                text[table] = text[table].replace(": "+fieldName, ": "+val+(isAllowNull ? "" : "!"))
                tablesAttrs[table].push(fieldName+": "+val+(isAllowNull ? "" : "!"))
              }
            }
            if(self.options.typescript) tsVal = val;
          }

          if(self.tables[table][field]['primaryKey'] == false && !self.tables[table][field]['foreignKey']) {
          }
          
        });

        // removes the last `,` within the attribute options
        text[table] = text[table].trim().replace(/,+$/, '') + "\n";

        // typescript, get definition for this field
        if(self.options.typescript) tsTableDef += tsHelper.def.getMemberDefinition(spaces, fieldName, tsVal, tsAllowNull);
      });

      text[table] += "}";



      //conditionally add additional options to tag on to orm objects
      var hasadditional = _.isObject(self.options.additional) && _.keys(self.options.additional).length > 0;

      //text[table] += ", {\n";

      //text[table] += spaces + spaces  + "tableName: '" + table + "',\n";

      if (hasadditional) {
        _.each(self.options.additional, addAdditionalOption)
      }

      text[table] = text[table].trim()
      // text[table] = text[table].substring(0, text[table].length - 1);
      // text[table] += "}";

      // typescript end table in definitions file
      if(self.options.typescript) typescriptFiles[0] += tsHelper.def.getTableDefinition(tsTableDef, tableName);
      
      function addAdditionalOption(value, key) {
        if (key === 'name') {
          // name: true - preserve table name always
          text[table] += spaces + spaces + "name: {\n";
          text[table] += spaces + spaces + spaces + "singular: '" + table + "',\n";
          text[table] += spaces + spaces + spaces + "plural: '" + table + "'\n";
          text[table] += spaces + spaces + "},\n";
        }
        else {
          value = _.isBoolean(value)?value:("'"+value+"'")
          text[table] += spaces + spaces + key + ": " + value + ",\n";
        }
      }

      _callback(null);
    }, function(){
      self.sequelize.close();
      
      // typescript generate tables
      if(self.options.typescript) typescriptFiles[1] = tsHelper.model.generateTableModels(tsTableNames, self.options.spaces, self.options.indentation);

      if (self.options.directory) {
        //return self.writeJs(text, typescriptFiles, callback);
        let query = "\ntype Query {\n"
        for(let table in text) {
          let methodName = self.normalizeTableName(table)
          methodName = methodName.charAt(0).toLowerCase() + methodName.substring(1);
          query += "  " +methodName+"s: "+ "["+self.normalizeTableName(table)+"!]!\n"
          query += "  " +methodName+"(id: ID!): "+ self.normalizeTableName(table)+"\n"
          console.log(text[table])
        }
        query += "}"
        console.log(query)

        // createUser(name: String, surname:String!, email: String!, password: String!, dt_born: String): User!
        // updateUser(id: ID!, name: String, surname:String!, email: String!, password: String!, dt_born: String): [Int!]!
        // deleteUser(id: ID!): Int!

        let mutation = "\ntype Mutation {\n"
        for(let table in tablesAttrs) {
          mutation += "  create"+self.normalizeTableName(table)+"("+tablesAttrs[table].join(", ")+"): "+self.normalizeTableName(table)+"!\n"
          mutation += "  update"+self.normalizeTableName(table)+"(id: ID!, "+tablesAttrs[table].join(", ")+"): [Int!]!\n"
          mutation += "  delete"+self.normalizeTableName(table)+"(id: ID!): Int!\n"
          // console.log(text[table])
        }
        mutation += "}"
        console.log(mutation)
        // tablesAttrs
      }
      return callback(false, text);
    });
  }
}

AutoSequelize.prototype.runGraphqlResolvers = function(callback) {
  var self = this;
  var text = {};
  var tables = [];
  var tablesAttrs = {};
  var tablesFields = {};
  var typescriptFiles = [self.options.typescript ? tsHelper.def.getDefinitionFileStart() : '', ''];
  var tsTableNames = [];

  this.build(generateText);

  function generateText(err) {
    var quoteWrapper = '"';
    if (err) console.error(err)

    async.each(_.keys(self.tables), function(table, _callback){
      var fields = _.keys(self.tables[table])
        , spaces = '';

      for (var x = 0; x < self.options.indentation; ++x) {
        spaces += (self.options.spaces === true ? ' ' : "\t");
      }

      var tableName = self.options.camelCase ? _.camelCase(table) : table;
      var tsTableDef = self.options.typescript ? 'export interface ' + tableName + 'Attribute {' : '';

      if(!self.options.typescript){
        
        text[table] = self.normalizeTableName(tableName)+": {\n"
      } else {
        tsTableNames.push(tableName);
        text[table] = tsHelper.model.getModelFileStart(self.options.indentation, spaces, tableName);
      }
      tablesAttrs[table] = []
      tablesFields[table] = []
      _.each(fields, function(field, i){
          var additional = self.options.additional
          if( additional && additional.timestamps !== undefined && additional.timestamps){
            if((additional.createdAt && field === 'createdAt' || additional.createdAt === field )
              ||(additional.updatedAt && field === 'updatedAt' || additional.updatedAt === field )
              ||(additional.deletedAt && field === 'deletedAt' || additional.deletedAt === field )){
              return true
            }
          }
        // Find foreign key
        var foreignKey = self.foreignKeys[table] && self.foreignKeys[table][field] ? self.foreignKeys[table][field] : null

        if (_.isObject(foreignKey)) {
          self.tables[table][field].foreignKey = foreignKey
        }

        // column's attributes
        var fieldAttr = _.keys(self.tables[table][field]);
        var fieldName = self.options.camelCase ? _.camelCase(field) : field;
        // text[table] += spaces + spaces + fieldName + ": "+(fieldName.toUpperCase() == "ID" ? "ID!" : fieldName)+"\n";

        // Serial key for postgres...
        var defaultVal = self.tables[table][field].defaultValue;

        // ENUMs for postgres...
        if (self.tables[table][field].type === "USER-DEFINED" && !! self.tables[table][field].special) {
          self.tables[table][field].type = "ENUM(" + self.tables[table][field].special.map(function(f){ return quoteWrapper + f + quoteWrapper; }).join(',') + ")";
        }

        // typescript
        var tsAllowNull = '';
        var isAllowNull = false;
        var tsVal = '';

        var isUnique = self.tables[table][field].foreignKey && self.tables[table][field].foreignKey.isUnique

        for(let k in fieldAttr) {
          let attr = fieldAttr[k]
          if (attr === "allowNull" && self.tables[table][field]['primaryKey'] == false) isAllowNull = true;
        }

        _.each(fieldAttr, function(attr, x){
          var isSerialKey = self.tables[table][field].foreignKey && _.isFunction(self.dialect.isSerialKey) && self.dialect.isSerialKey(self.tables[table][field].foreignKey)

          // We don't need the special attribute from postgresql describe table..
          if (attr === "special") {
            return true;
          }

          if (attr === "foreignKey") {
            if (isSerialKey) {
            } else if (foreignKey.isForeignKey) {
              if(self.tables[table][field]['primaryKey'] == false && self.tables[table][field]['foreignKey']) {
                // text[table] = text[table].replace(": "+fieldName, ": ID"+(isAllowNull ? "" : "!"))
              }
            } else return true
          }
          else if (attr === "primaryKey") {
            var _attr = (self.tables[table][field]["type"] || '').toLowerCase();
            if (self.tables[table][field][attr] === true && 
                _attr.match(/^(smallint|mediumint|tinyint|int|bigint|long)/) && 
                (! _.has(self.tables[table][field], 'foreignKey') || (_.has(self.tables[table][field], 'foreignKey') && !! self.tables[table][field].foreignKey.isPrimaryKey)))
            {
                if(self.tables[table][field]['foreignKey'] && self.tables[table][field]['foreignKey'].isForeignKey == true)
                  return true;
            } else {
              return true;
            }
          }
          else if (attr === "allowNull" && self.tables[table][field]['primaryKey'] == false) {
            if(self.options.typescript) tsAllowNull = self.tables[table][field][attr];
          }
          else if (attr === "defaultValue") {
            if (self.sequelize.options.dialect === "mssql" &&  defaultVal && defaultVal.toLowerCase() === '(newid())') {
              defaultVal = null; // disable adding "default value" attribute for UUID fields if generating for MS SQL
            }

            var val_text = defaultVal;

            if (isSerialKey) return true

            //mySql Bit fix
            if (self.tables[table][field].type.toLowerCase() === 'bit(1)') {
              val_text = defaultVal === "b'1'" ? 1 : 0;
            }
            // mssql bit fix
            else if (self.sequelize.options.dialect === "mssql" && self.tables[table][field].type.toLowerCase() === "bit") {
              val_text = defaultVal === "((1))" ? 1 : 0;
            }

            if (_.isString(defaultVal)) {
              var field_type = self.tables[table][field].type.toLowerCase();
              if (_.endsWith(defaultVal, '()')) {
                val_text = "sequelize.fn('" + defaultVal.replace(/\(\)$/, '') + "')"
              }
              else if (field_type.indexOf('date') === 0 || field_type.indexOf('timestamp') === 0) {
                 if (_.includes(['current_timestamp', 'current_date', 'current_time', 'localtime', 'localtimestamp'], defaultVal.toLowerCase())) {
                  val_text = "sequelize.literal('" + defaultVal + "')"
                } else {
                  val_text = quoteWrapper + val_text + quoteWrapper
                }
              } else {
                val_text = quoteWrapper + val_text + quoteWrapper
              }
            }

            if(defaultVal === null || defaultVal === undefined) {
              return true;
            } else {
              val_text = _.isString(val_text) && !val_text.match(/^sequelize\.[^(]+\(.*\)$/) ? SqlString.escape(_.trim(val_text, '"'), null, self.options.dialect) : val_text;

              // don't prepend N for MSSQL when building models...
              val_text = _.trimStart(val_text, 'N')
            }
          }
          else if (attr === "type" && self.tables[table][field][attr].indexOf('ENUM') === 0) {
            var options = self.tables[table][field][attr].replace("ENUM(", "");
            options = options.replace(")","");
            options = options.replace(/'/g,"");
            options = options.split(",");
            var newOptions = [];
            options.forEach(function(e, i, a){
              newOptions.push('"'+e+'": "'+e+'"');
            });
            newOptions = newOptions.join(",");
          } else if (attr === "type" && self.tables[table][field][attr].indexOf('SET') === 0) {
            var options = self.tables[table][field][attr].replace("SET(", "");
            
            options = options.replace(")","");
            options = options.replace(/'/g,"");
            options = options.split(",");
            var newOptions = [];
            options.forEach(function(e, i, a){
              newOptions.push('"'+e+'": "'+e+'"');
            });
            newOptions = newOptions.join(",");
          } else {
            var _attr = (self.tables[table][field][attr] || '').toLowerCase();
            var val = quoteWrapper + self.tables[table][field][attr] + quoteWrapper;

            if (_attr === "boolean" || _attr === "bit(1)" || _attr === "bit" || _attr === "tinyint(1)") {
              val = 'Boolean';
            }
            else if (_attr.match(/^(smallint|mediumint|tinyint|int)/)) {
              var length = _attr.match(/\(\d+\)/);
              val = 'Int';
            }
            else if (_attr.match(/^bigint/)) {
              val = 'Int';
            }
            else if (_attr.match(/^varchar/)) {
              var length = _attr.match(/\(\d+\)/);
              val = 'String';
            }
            else if (_attr.match(/^string|varying|nvarchar/)) {
              val = 'String';
            }
            else if (_attr.match(/^char/)) {
              var length = _attr.match(/\(\d+\)/);
              val = 'String';
            }
            else if (_attr.match(/^real/)) {
              val = 'String';
            }
            else if (_attr.match(/text|ntext$/)) {
              val = 'String';
            }
            else if (_attr.match(/^(date|timestamp)/)) {
              val = 'String';
            }
            else if (_attr.match(/^(time)/)) {
              val = 'String';
            }
            else if (_attr.match(/^(float|float4)/)) {
              val = 'String';
            }
            else if (_attr.match(/^decimal/)) {
              val = 'String';
            }
            else if (_attr.match(/^(float8|double precision|numeric)/)) {
              val = 'String';
            }
            else if (_attr.match(/^uuid|uniqueidentifier/)) {
              val = 'String';
            }
            else if (_attr.match(/^jsonb/)) {
              val = 'String';
            }
            else if (_attr.match(/^json/)) {
              val = 'String';
            }
            else if (_attr.match(/^geometry/)) {
              val = 'String';
            }
            if(self.tables[table][field]['primaryKey'] == false || val == "text" || val == "textarea") {
              if(!self.tables[table][field]['foreignKey'] && fieldName.toUpperCase() != "ID") {
                // text[table] = text[table].replace(": "+fieldName, ": "+val+(isAllowNull ? "" : "!"))
                tablesAttrs[table].push(fieldName+": "+val+(isAllowNull ? "" : "!"))
                tablesFields[table].push(fieldName)
              }
            }
            if(self.options.typescript) tsVal = val;
          }

          if(self.tables[table][field]['primaryKey'] == false && !self.tables[table][field]['foreignKey']) {
          }
          
        });

        // removes the last `,` within the attribute options
        text[table] = text[table].trim().replace(/,+$/, '') + "\n";

        // typescript, get definition for this field
        if(self.options.typescript) tsTableDef += tsHelper.def.getMemberDefinition(spaces, fieldName, tsVal, tsAllowNull);
      });

      text[table] += "}";



      //conditionally add additional options to tag on to orm objects
      var hasadditional = _.isObject(self.options.additional) && _.keys(self.options.additional).length > 0;

      //text[table] += ", {\n";

      //text[table] += spaces + spaces  + "tableName: '" + table + "',\n";

      if (hasadditional) {
        _.each(self.options.additional, addAdditionalOption)
      }

      text[table] = text[table].trim()
      // text[table] = text[table].substring(0, text[table].length - 1);
      // text[table] += "}";

      // typescript end table in definitions file
      if(self.options.typescript) typescriptFiles[0] += tsHelper.def.getTableDefinition(tsTableDef, tableName);
      
      function addAdditionalOption(value, key) {
        if (key === 'name') {
          // name: true - preserve table name always
          text[table] += spaces + spaces + "name: {\n";
          text[table] += spaces + spaces + spaces + "singular: '" + table + "',\n";
          text[table] += spaces + spaces + spaces + "plural: '" + table + "'\n";
          text[table] += spaces + spaces + "},\n";
        }
        else {
          value = _.isBoolean(value)?value:("'"+value+"'")
          text[table] += spaces + spaces + key + ": " + value + ",\n";
        }
      }

      _callback(null);
    }, function(){
      self.sequelize.close();
      
      // typescript generate tables
      if(self.options.typescript) typescriptFiles[1] = tsHelper.model.generateTableModels(tsTableNames, self.options.spaces, self.options.indentation);

      if (self.options.directory) {
        //return self.writeJs(text, typescriptFiles, callback);
        let query = "\nQuery: {\n"
        for(let table in text) {
          let methodName = self.normalizeTableName(table)
          methodName = methodName.charAt(0).toLowerCase() + methodName.substring(1);
          query += "  " +methodName+"s: (parent, args, { db }, info) => db."+table+".findAll(),\n"
          query += "  " +methodName+": (parent, { id }, { db }, info) => db."+table+".findByPk(id),\n"
          console.log(text[table])
        }
        query += "}"
        console.log(query)

        // Mutation: {
        //   createUser: (parent, { name, surname, email, password, dt_born }, { db }, info) =>
        //     db.cad_user.create({
        //       name: name,
        //       surname: surname,
        //       email: email,
        //       password: password,
        //       dt_born: dt_born
        //     }),
        //   updateUser: (parent, { id, name, surname, email, password, dt_born }, { db }, info) =>
        //     db.cad_user.update({
        //       name: name,
        //       surname: surname,
        //       email: email,
        //       password: password,
        //       dt_born: dt_born
        //     },
        //     {
        //       where: {
        //         id: id
        //       }
        //     }),
        //   deleteUser: (parent, {id}, { db }, info) =>
        //     db.cad_user.destroy({
        //       where: {
        //         id: id
        //       }
        //     })
        // }

        let mutation = "\nMutation: {\n"
        for(let table in tablesAttrs) {
          let tableFieldsDup = []
          for(let k in tablesFields[table]) {
            tableFieldsDup.push(tablesFields[table][k]+": "+tablesFields[table][k])
          }
          mutation += "  create"+self.normalizeTableName(table)+": (parent, { "+tablesFields[table].join(", ")+" }, { db }, info) => \n "
          mutation += "    db."+table+".create({\n      "
          mutation += tableFieldsDup.join(",\n      ")
          mutation += "\n    }),\n"

          mutation += "  update"+self.normalizeTableName(table)+": (parent, { id, "+tablesFields[table].join(", ")+" }, { db }, info) => \n "
          mutation += "    db."+table+".update({\n      "
          mutation += tableFieldsDup.join(",\n      ")
          mutation += "\n    },\n    {\n      where: {\n        id: id\n      }\n    }),\n"
          
          mutation += "  delete"+self.normalizeTableName(table)+": (parent, { id }, { db }, info) => \n "
          mutation += "    db."+table+".destroy({\n      where: {\n        id: id\n      }\n    }),\n"
          // console.log(text[table])
        }
        mutation += "}"
        console.log(mutation)
        // tablesAttrs
      }
      return callback(false, text);
    });
  }
}

AutoSequelize.prototype.capitalize = function(string) {
    string = string.toLowerCase();
    string = string.charAt(0).toUpperCase() + string.substring(1);
    return string;
  }

AutoSequelize.prototype.write = function(attributes, typescriptFiles, callback) {
  var tables = _.keys(attributes);
  var self = this;

  mkdirp.sync(path.resolve(self.options.directory));

  async.each(tables, createFile, !self.options.eslint ? callback : function() {
    var engine = new CLIEngine({ fix: true });
    var report = engine.executeOnFiles([self.options.directory]);
    CLIEngine.outputFixes(report);
    callback();
  });

  if(self.options.typescript){
    if(typescriptFiles != null && typescriptFiles.length > 1){
      fs.writeFileSync(path.join(self.options.directory, 'db.d.ts'), typescriptFiles[0], 'utf8');
      fs.writeFileSync(path.join(self.options.directory, 'db.tables.ts'), typescriptFiles[1], 'utf8');
    }
  }

  function createFile(table, _callback) {
    var fileName = self.options.camelCaseForFileName ? _.camelCase(table) : table;
    fs.writeFile(path.resolve(path.join(self.options.directory, fileName + (self.options.typescript ? '.ts' : '.json'))), attributes[table], _callback);
  }
}

AutoSequelize.prototype.writeJs = function(attributes, typescriptFiles, callback) {
  var tables = _.keys(attributes);
  var self = this;

  mkdirp.sync(path.resolve(self.options.directory));

  async.each(tables, createFile, !self.options.eslint ? callback : function() {
    var engine = new CLIEngine({ fix: true });
    var report = engine.executeOnFiles([self.options.directory]);
    CLIEngine.outputFixes(report);
    callback();
  });

  if(self.options.typescript){
    if(typescriptFiles != null && typescriptFiles.length > 1){
      fs.writeFileSync(path.join(self.options.directory, 'db.d.ts'), typescriptFiles[0], 'utf8');
      fs.writeFileSync(path.join(self.options.directory, 'db.tables.ts'), typescriptFiles[1], 'utf8');
    }
  }

  function createFile(table, _callback) {
    var fileName = self.options.camelCaseForFileName ? _.camelCase(table) : table;
    fs.writeFile(path.resolve(path.join(self.options.directory, fileName + (self.options.typescript ? '.ts' : '.js'))), attributes[table], _callback);
  }
}

module.exports = AutoSequelize
