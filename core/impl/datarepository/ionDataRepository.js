// jscs:disable requireCamelCaseOrUpperCaseIdentifiers
/**
 * Created by Vasiliy Ermilov (email: inkz@xakep.ru, telegram: @inkz1) on 29.04.16.
 */
'use strict';

const DataRepositoryModule = require('core/interfaces/DataRepository');
const DataRepository = DataRepositoryModule.DataRepository;
const Item = DataRepositoryModule.Item;
const PropertyTypes = require('core/PropertyTypes');
const ChangeLogger = require('core/interfaces/ChangeLogger');
const cast = require('core/cast');
const EventType = require('core/interfaces/ChangeLogger').EventType;
const uuid = require('node-uuid');
const EventManager = require('core/impl/EventManager');
const ConditionParser = require('core/ConditionParser');

/* jshint maxstatements: 100, maxcomplexity: 100, maxdepth: 30 */
/**
 * @param {{}} options
 * @param {DataSource} options.dataSource
 * @param {MetaRepository} options.metaRepository
 * @param {KeyProvider} options.keyProvider
 * @param {Logger} [options.log]
 * @param {String} [options.namespaceSeparator]
 * @param {Number} [options.maxEagerDepth]
 * @constructor
 */
function IonDataRepository(options) {
  var _this = this;
  EventManager.apply(this);

  /**
   * @type {DataSource}
   */
  this.ds = options.dataSource;

  /**
   * @type {MetaRepository}
   */
  this.meta = options.metaRepository;

  /**
   * @type {KeyProvider}
   */
  this.keyProvider = options.keyProvider;

  /**
   * @type {ResourceStorage}
   */
  this.fileStorage = options.fileStorage;

  /**
   * @type {ImageStorage}
   */
  this.imageStorage = options.imageStorage || options.fileStorage;

  this.namespaceSeparator = options.namespaceSeparator || '_';

  this.maxEagerDepth = -(isNaN(options.maxEagerDepth) ? 2 : options.maxEagerDepth);

  const geoOperations = ['$geoWithin', '$geoIntersects'];

  /**
   * @param {ClassMeta} cm
   * @returns {String}
   */
  function tn(cm) {
    return (cm.getNamespace() ? cm.getNamespace() + _this.namespaceSeparator : '') + cm.getName();
  }

  /**
   *
   * @param {Object[]} validators
   * @returns {Promise}
   */
  this._setValidators = function (validators) {
    return new Promise(function (resolve) { resolve(); });
  };

  /**
   * @param {String | Item} obj
   * @private
   * @returns {ClassMeta | null}
   */
  this._getMeta = function (obj) {
    if (typeof obj === 'string') {
      return this.meta.getMeta(obj);
    } else if (typeof obj === 'object' && obj.constructor.name === 'Item') {
      return obj.classMeta;
    }
    return null;
  };

  /**
   * @param {ClassMeta} cm
   * @private
   * @returns {ClassMeta}
   */
  this._getRootType = function (cm) {
    if (cm.ancestor) {
      return this._getRootType(cm.ancestor);
    }
    return cm;
  };

  /**
   * @param {Object} filter
   * @param {ClassMeta} cm
   * @private
   */
  this._addDiscriminatorFilter = function (filter, cm) {
    var descendants = this.meta.listMeta(cm.getCanonicalName(), cm.getVersion(), false, cm.getNamespace());
    var cnFilter = [cm.getCanonicalName()];
    for (var i = 0; i < descendants.length; i++) {
      cnFilter.push(descendants[i].getCanonicalName());
    }

    if (!filter) {
      return {_class: {$in: cnFilter}};
    } else {
      return {$and: [{_class: {$in: cnFilter}}, filter]};
    }
  };

  /**
   * @param {Object} filter
   * @param {Item} item
   * @returns {Object}
   * @private
   */
  this._addFilterByItem = function (filter, item) {
    if (typeof item === 'object' && item.constructor.name === 'Item') {
      var conditions, props;
      conditions = [filter];
      props = item.getProperties();
      for (var nm in props) {
        if (props.hasOwnProperty(nm) && item.base.hasOwnProperty(nm)) {
          var c = {};
          c[nm] = item.base[nm];
          conditions.push(c);
        }
      }
      return {$and: conditions};
    }
    return filter;
  };

  /**
   * @param {String} className
   * @param {Object} data
   * @param {String} [version]
   * @param {{autoassign: Boolean}} [options]
   * @private
   * @returns {Item | null}
   */
  this._wrap = function (className, data, version, options) {
    var acm = this.meta.getMeta(className, version);
    delete data._id;
    if (options && options.autoassign) {
      autoAssign(acm, data, true);
    }
    return new Item(this.keyProvider.formKey(acm.getName(), data, acm.getNamespace()), data, acm);
  };

  /**
   *
   * @param {String | Item} obj
   * @param {{filter: Object}} [options]
   * @returns {Promise}
   */
  this._getCount  = function (obj, options) {
    if (!options) {
      options = {};
    }
    var cm = this._getMeta(obj);
    var rcm = this._getRootType(cm);
    options.filter = this._addFilterByItem(options.filter, obj);
    options.filter = this._addDiscriminatorFilter(options.filter, cm);
    return this.ds.count(tn(rcm), options);
  };

  /**
   * @param {Item} item
   * @param {Property} property
   * @param {{}} attrs
   * @param {{}} loaded
   */
  function prepareRefEnrichment(item, property, attrs, loaded) {
    var refc = property.meta._refClass;
    if (refc) {
      if (!attrs.hasOwnProperty(item.classMeta.getName() + '.' + property.getName())) {
        attrs[item.classMeta.getName() + '.' + property.getName()] = {
          type: PropertyTypes.REFERENCE,
          refClassName: refc.getCanonicalName(),
          attrName: property.getName(),
          key: refc.getKeyProperties()[0],
          pIndex: 0,
          filter: []
        };
      }
      var v;
      if (property.meta.backRef) {
        v = item.getItemId();
        attrs[item.classMeta.getName() + '.' + property.getName()].key = property.meta.backRef;
        attrs[item.classMeta.getName() + '.' + property.getName()].backRef = true;
      } else {
        v = item.get(property.getName());
      }

      if (v) {
        if (typeof item.references === 'undefined') {
          item.references = {};
        }
        if (!property.meta.backRef && loaded.hasOwnProperty(refc.getCanonicalName() + '@' + v)) {
          item.references[property.getName()] =
            _this._wrap(refc.getCanonicalName(), loaded[refc.getCanonicalName() + '@' + v].base);
        } else {
          attrs[item.classMeta.getName() + '.' + property.getName()].filter.push(v);
        }
      }
    }
  }

  /**
   * @param {Item} item
   * @param {Property} property
   * @param {{}} attrs
   * @param {{}} loaded
   */
  function prepareColEnrichment(item, property, attrs, loaded) {
    var refc = property.meta._refClass;
    item.collections = item.collections || {};
    if (refc) {
      if (!attrs.hasOwnProperty(item.classMeta.getName() + '.' + property.getName())) {
        attrs[item.classMeta.getName() + '.' + property.getName()] = {
          type: PropertyTypes.COLLECTION,
          colClassName: refc.getCanonicalName(),
          attrName: property.getName(),
          key: refc.getKeyProperties()[0],
          backRef: property.meta.backRef,
          pIndex: 0,
          colItems: []
        };
      }

      if (property.meta.backRef && !property.meta.backColl) {
        if (property.meta.binding) {
          attrs[item.classMeta.getName() + '.' + property.getName()].colItems.push(item.get(property.meta.binding));
        } else {
          attrs[item.classMeta.getName() + '.' + property.getName()].colItems.push(item.getItemId());
        }
        if (property.meta.selConditions) {
          attrs[item.classMeta.getName() + '.' + property.getName()].colFilter =
            ConditionParser(property.meta.selConditions, property.meta._refClass, item);
          if (!attrs[item.classMeta.getName() + '.' + property.getName()].colFilter) {
            delete attrs[item.classMeta.getName() + '.' + property.getName()].colFilter;
          }
        }
      } else {
        var v = item.get(property.getName());
        if (Array.isArray(v)) {
          item.collections[property.getName()] = [];
          v.forEach(function (v) {
            if (loaded.hasOwnProperty(refc.getCanonicalName() + '@' + v)) {
              item.collections[property.getName()].push(
                _this._wrap(refc.getCanonicalName(), loaded[refc.getCanonicalName() + '@' + v].base)
              );
            } else {
              attrs[item.classMeta.getName() + '.' + property.getName()].colItems.push(v);
            }
          });
        }
      }
    }
  }

  function formForced(param, forced) {
    if (param && Array.isArray(param)) {
      for (var i = 0; i < param.length; i++) {
        if (!forced.hasOwnProperty(param[i][0])) {
          forced[param[i][0]] = [];
        }
        if (param[i].length > 1) {
          forced[param[i][0]].push(param[i].slice(1));
        }
      }
    }
  }

  /**
   * @param {Item[]} src
   * @param {Number} depth
   * @param {String[][]} [forced]
   * @param {{}} [loaded]
   * @returns {Promise}
   */
  function enrich(src, depth, forced, loaded) {
    return new Promise(function (resolve, reject) {
      var i, nm, attrs, item, props, promises, filter, cn, cm, forced2, pcl;

      forced2 = {};
      formForced(forced, forced2);
      attrs = {};
      promises = [];
      loaded = loaded || {};

      try {
        pcl = {};
        for (i = 0; i < src.length; i++) {
          loaded[src[i].getClassName() + '@' + src[i].getItemId()] = src[i];
        }

        for (i = 0; i < src.length; i++) {
          item = src[i];
          if (item && item.constructor.name === 'Item') {
            cm = item.getMetaClass();
            if (!pcl.hasOwnProperty(cm.getName())) {
              pcl[cm.getName()] = true;
              formForced(cm.getForcedEnrichment(), forced2);
            }
            props = item.getProperties();
            for (nm in props) {
              if (props.hasOwnProperty(nm)) {
                if (
                  depth > 0 ||
                  (forced2.hasOwnProperty(nm) || props[nm].eagerLoading()) && depth >= _this.maxEagerDepth
                ) {
                  if (props[nm].getType() === PropertyTypes.REFERENCE) {
                    prepareRefEnrichment(item, props[nm], attrs, loaded);
                  } else if (props[nm].getType() === PropertyTypes.COLLECTION && props[nm].eagerLoading()) {
                    prepareColEnrichment(item, props[nm], attrs, loaded);
                  }
                }
              }
            }
          }
        }

        promises = [];

        i = 0;
        for (nm in attrs) {
          if (attrs.hasOwnProperty(nm)) {
            filter = null;
            if (
              attrs[nm].type  === PropertyTypes.REFERENCE &&
              Array.isArray(attrs[nm].filter) &&
              attrs[nm].filter.length
            ) {
              filter = {};
              filter[attrs[nm].key] = {$in: attrs[nm].filter};
              cn = attrs[nm].refClassName;
            } else if (
              attrs[nm].type  === PropertyTypes.COLLECTION &&
              Array.isArray(attrs[nm].colItems) &&
              attrs[nm].colItems.length
            ) {
              filter = {};
              filter[attrs[nm].backRef ? attrs[nm].backRef : attrs[nm].key] = {$in: attrs[nm].colItems};
              if (attrs[nm].colFilter) {
                filter = {$and: [filter, attrs[nm].colFilter]};
              }
              cn = attrs[nm].colClassName;
            }

            if (filter) {
              attrs[nm].pIndex = i;
              i++;
              promises.push(
                _this._getList(cn,
                  {
                    filter: filter,
                    nestingDepth: depth - 1,
                    forceEnrichment: forced2[attrs[nm].attrName],
                    ___loaded: loaded
                  }
                )
              );
            }
          }
        }
      } catch (err) {
        reject(err);
      }

      if (promises.length === 0) {
        resolve(src);
      }

      Promise.all(promises).then(
        function (results) {
          var nm, items, itemsByKey, srcByKey, ids, i, j, v;
          for (nm in attrs) {
            if (attrs.hasOwnProperty(nm)) {
              items = results[attrs[nm].pIndex];
              if (!items || items.length === 0) {
                continue;
              }
              if (attrs[nm].type === PropertyTypes.REFERENCE) {
                itemsByKey = {};
                if (attrs[nm].backRef) {
                  for (i = 0; i < items.length; i++) {
                    v = items[i].get(attrs[nm].key);
                    if (!itemsByKey.hasOwnProperty(v)) {
                      itemsByKey[v] = [];
                    }
                    itemsByKey[v].push(items[i]);
                  }

                  for (i = 0; i < src.length; i++) {
                    if (itemsByKey.hasOwnProperty(src[i].getItemId())) {
                      if (itemsByKey[src[i].getItemId()].length > 1 && options.log) {
                        options.log.warn('Обратной ссылке "' +
                          src[i].property(attrs[nm].attrName).getCaption() +
                          '" соответствует несколько объектов '
                        );
                      }
                      src[i].base[attrs[nm].attrName] = itemsByKey[src[i].getItemId()][0].getItemId();
                      src[i].references[attrs[nm].attrName] = itemsByKey[src[i].getItemId()][0];
                    }
                  }
                } else {
                  for (i = 0; i < items.length; i++) {
                    itemsByKey[items[i].getItemId()] = items[i];
                  }

                  for (i = 0; i < src.length; i++) {
                    if (itemsByKey.hasOwnProperty(src[i].base[attrs[nm].attrName])) {
                      src[i].references[attrs[nm].attrName] = itemsByKey[src[i].base[attrs[nm].attrName]];
                    }
                  }
                }
              } else if (attrs[nm].type === PropertyTypes.COLLECTION) {
                if (attrs[nm].backRef) {
                  if (!srcByKey) {
                    srcByKey = {};

                    for (i = 0; i < src.length; i++) {
                      srcByKey[src[i].getItemId()] = src[i];
                    }
                  }

                  for (i = 0; i < items.length; i++) {
                    if (srcByKey.hasOwnProperty(items[i].base[attrs[nm].backRef])) {
                      if (typeof srcByKey[items[i].base[attrs[nm].backRef]].
                          collections[attrs[nm].attrName] === 'undefined') {
                        srcByKey[items[i].base[attrs[nm].backRef]].collections[attrs[nm].attrName] = [];
                      }
                      srcByKey[items[i].base[attrs[nm].backRef]].collections[attrs[nm].attrName].push(items[i]);
                    }
                  }
                } else {
                  itemsByKey = {};
                  for (i = 0; i < items.length; i++) {
                    itemsByKey[items[i].getItemId()] = items[i];
                  }
                  for (i = 0; i < src.length; i++) {
                    ids = src[i].get(attrs[nm].attrName) || [];
                    src[i].collections[attrs[nm].attrName] = [];
                    for (j = 0; j < ids.length; j++) {
                      if (itemsByKey.hasOwnProperty(ids[j])) {
                        src[i].collections[attrs[nm].attrName].push(itemsByKey[ids[j]]);
                      }
                    }
                  }
                }
              }
            }
          }
          resolve(src);
        }
      ).catch(reject);
    });
  }

  /**
   * @param {Item} item
   * @returns {Promise}
   */
  function loadFiles(item) {
    var pm;
    var fids = [];
    var iids = [];
    var attrs = {};
    for (var nm in item.base) {
      if (item.base.hasOwnProperty(nm) && item.base[nm]) {
        pm = item.classMeta.getPropertyMeta(nm);
        if (pm) {
          if (pm.type === PropertyTypes.FILE || pm.type === PropertyTypes.IMAGE) {
            fids.push(item.base[nm]);
            if (!attrs.hasOwnProperty('f_' + item.base[nm])) {
              attrs['f_' + item.base[nm]] = [];
            }
            attrs['f_' + item.base[nm]].push(nm);
            if (pm.type === PropertyTypes.FILE) {
              fids.push(item.base[nm]);
            } else if (pm.type === PropertyTypes.IMAGE) {
              iids.push(item.base[nm]);
            }
          } else if (pm.type === PropertyTypes.FILE_LIST) {
            if (Array.isArray(item.base[nm])) {
              for (var i = 0; i < item.base[nm].length; i++) {
                fids.push(item.base[nm][i]);
                if (!attrs.hasOwnProperty('f_' + item.base[nm][i])) {
                  attrs['f_' + item.base[nm][i]] = [];
                }
                attrs['f_' + item.base[nm][i]].push({attr: nm, index: i});
              }
            }
          }
        }
      }
    }
    return new Promise(function (resolve, reject) {
      if (fids.length === 0 && iids.length === 0) {
        resolve(item);
        return;
      }

      var loaders = [];
      loaders.push(_this.fileStorage.fetch(fids));
      loaders.push(_this.imageStorage.fetch(iids));

      Promise.all(loaders).then(function (files) {
        var tmp, i, j, k;
        for (k = 0; k < files.length; k++) {
          for (i = 0; i < files[k].length; i++) {
            if (attrs.hasOwnProperty('f_' + files[k][i].id)) {
              for (j = 0; j < attrs['f_' + files[k][i].id].length; j++) {
                tmp = attrs['f_' + files[k][i].id][j];
                if (typeof tmp === 'object') {
                  if (!Array.isArray(item.files[tmp.attr])) {
                    item.files[tmp.attr] = [];
                  }
                  item.files[tmp.attr][tmp.index] = files[k][i];
                } else if (typeof tmp === 'string') {
                  item.files[tmp] = files[k][i];
                }
              }
            }
          }
        }
        resolve(item);
      }).catch(reject);
    });
  }

  /**
   * @param {ClassMeta} cm
   * @param {{}} context
   * @param {String} attr
   * @param {String} operation
   * @param {{className: String, collectionName: String, property: String, filter: {}}} options
   * @param {Array} fetchers
   */
  function prepareAgregOperation(cm, context, attr, operation, options, fetchers) {
    var cn;
    if (options.className) {
      cn = options.className;
    } else if (options.collectionName) {
      cn = _this.meta.getMeta(cm.getPropertyMeta(options.collectionName), null, cm.getNamespace()).
      getCanonicalName();
    }

    var oper = {};
    oper[operation.substring(1)] = options.property;

    var result = new Promise(
      function (resolve, reject) {
        _this._aggregate(cn,
          {
            filter: options.filter,
            expressions: {
              val: oper
            }
          }
        ).
        then(
          function (result) {
            context[attr] = result.val;
            resolve();
          }
        ).
        catch(reject);
      }
    );

    fetchers.push(result);
    return result;
  }

  function join(pm, cm, colMeta, filter) {
    return {
        table: tn(colMeta),
        many: !pm.backRef,
        left: pm.backRef ? (pm.binding ? pm.binding : cm.getKeyProperties()[0]) : pm.name,
        right: pm.backRef ? pm.backRef : colMeta.getKeyProperties()[0],
        filter: filter
      };
  }

  /**
   * @param {ClassMeta} cm
   * @param {{type: Number}} pm
   * @param {{}} filter
   * @param {String} nm
   * @param {Array} fetchers
   * @param {Array} containCheckers
   */
  function prepareContains(cm, pm, filter, nm, fetchers, containCheckers) {
    var colMeta = pm._refClass;
    var tmp = prepareFilterOption(colMeta, filter[nm].$contains, fetchers, filter, nm);
    if (!pm.backRef && colMeta.getKeyProperties().length > 1) {
      throw new Error('Условия на коллекции на составных ключах не поддерживаются!');
    }
    containCheckers.push({$joinExists: join(pm, cm, colMeta, tmp)});
  }

  /**
   * @param {ClassMeta} cm
   * @param {{type: Number}} pm
   * @param {{}} filter
   * @param {String} nm
   * @param {Array} fetchers
   * @param {Array} containCheckers
   */
  function prepareEmpty(cm, pm, filter, nm, fetchers, containCheckers) {
    var colMeta = pm._refClass;
    if (!pm.backRef && colMeta.getKeyProperties().length > 1) {
      throw new Error('Условия на коллекции на составных ключах не поддерживаются!');
    }

    if (filter[nm].$empty) {
      containCheckers.push({$joinNotExists: join(pm, cm, colMeta, null)});
    } else {
      containCheckers.push({$joinExists: join(pm, cm, colMeta, null)});
    }
  }

  /**
   * @param {ClassMeta} cm
   * @param {String[]} path
   * @param {{}} filter
   * @param {String} nm
   * @param {Array} fetchers
   * @param {{}} linkedCheckers
   */
  function prepareLinked(cm, path, filter, nm, fetchers, linkedCheckers) {
    var i, lc, rMeta, n;
    var pm = cm.getPropertyMeta(path[0]);
    if (pm && pm.type === PropertyTypes.REFERENCE && path.length > 1) {
      rMeta = pm._refClass;
      if (!pm.backRef && rMeta.getKeyProperties().length > 1) {
        throw new Error('Условия на ссылки на составных ключах не поддерживаются!');
      }
      if (linkedCheckers.hasOwnProperty(path[0])) {
        lc = linkedCheckers[path[0]];
      } else {
        lc = {
          $joinExists: {
            table: tn(rMeta),
            many: false,
            left: pm.backRef ? cm.getKeyProperties()[0] : pm.name,
            right: pm.backRef ? pm.backRef : rMeta.getKeyProperties()[0],
            filter: null,
            forAttr: pm.name
          }
        };
        linkedCheckers[path[0]] = lc;
      }

      var f = lc.$joinExists.filter || {$and: []};
      var fo;
      if (path.length === 2) {
        fo = {};
        fo[path[1]] = prepareFilterOption(rMeta, filter[nm], fetchers, fo, path[1]);
        f.$and.push(fo);
      } else {
        var joins = {};
        for (i = 0; i < f.$and.length; i++) {
          if (f.$and[i].hasOwnProperty('$joinExists')) {
            joins[f.$and[i].$joinExists.forAttr] = f.$and[i];
          }
        }
        prepareLinked(rMeta, path.slice(1), filter, nm, fetchers, joins);
        for (n in joins) {
          if (joins.hasOwnProperty(n)) {
            if (f.$and.indexOf(joins[n]) < 0) {
              f.$and.push(joins[n]);
            }
          }
        }
      }
      if (f.$and.length) {
        lc.$joinExists.filter = f;
      }
    }
  }

  /**
   * @param {ClassMeta} cm
   * @param {{}} filter
   * @param {Array} fetchers
   * @param {{}} [parent]
   * @param {String} [part]
   * @param {{}} [propertyMeta]
   * @returns {*}
   */
  function prepareFilterOption(cm, filter, fetchers, parent, part, propertyMeta) {
    var i, knm, nm, keys, pm, emptyResult, result, containCheckers, linkedCheckers;
    if (geoOperations.indexOf(part) !== -1) {
      return filter;
    } else if (filter && Array.isArray(filter)) {
      result = [];
      for (i = 0; i < filter.length; i++) {
        result.push(prepareFilterOption(cm, filter[i], fetchers, result, i));
      }
      return result;
    } else if (filter && typeof filter === 'object' && !(filter instanceof Date)) {
      result = {};
      containCheckers = [];
      linkedCheckers = {};
      emptyResult = true;
      for (nm in filter) {
        if (filter.hasOwnProperty(nm)) {
          if ((pm = cm.getPropertyMeta(nm)) !== null) {
            if (pm.type === PropertyTypes.COLLECTION) {
              for (knm in filter[nm]) {
                if (filter[nm].hasOwnProperty(knm) && knm === '$contains') {
                  prepareContains(cm, pm, filter, nm, fetchers, containCheckers);
                  break;
                }

                if (filter[nm].hasOwnProperty(knm) && knm === '$empty') {
                  prepareEmpty(cm, pm, filter, nm, fetchers, containCheckers);
                  break;
                }
              }
            } else {
              result[nm] = prepareFilterOption(cm, filter[nm], fetchers, result, nm, pm);
              emptyResult = false;
            }
          } else if (nm === '$ItemId') {
            if (typeof filter[nm] === 'string') {
              keys = formUpdatedData(cm, _this.keyProvider.keyToData(cm.getName(), filter[nm], cm.getNamespace()));
              for (knm in keys) {
                if (keys.hasOwnProperty(knm)) {
                  result[knm] = keys[knm];
                  emptyResult = false;
                }
              }
            } else {
              result[cm.getKeyProperties()[0]] = filter[nm];
              emptyResult = false;
            }
          } else if (['$min', '$max', '$avg', '$sum', '$count'].indexOf(nm) >= 0) {
            result[nm] = prepareAgregOperation(cm, parent, part, nm, filter[nm], fetchers);
            emptyResult = false;
          } else if (nm === '$exists') {
            result[nm] = filter[nm];
            emptyResult = false;
          } else if (nm.indexOf('.') > 0) {
            prepareLinked(cm, nm.split('.'), filter, nm, fetchers, linkedCheckers);
          } else {
            result[nm] = prepareFilterOption(cm, filter[nm], fetchers, result, nm, propertyMeta);
            emptyResult = false;
          }
        }
      }

      for (nm in linkedCheckers) {
        if (linkedCheckers.hasOwnProperty(nm)) {
          containCheckers.push(linkedCheckers[nm]);
        }
      }

      if (containCheckers.length) {
        if (!emptyResult) {
          containCheckers.push(result);
        }
        return {
          $and: containCheckers
        };
      }

      if (emptyResult) {
        return null;
      }

      return result;
    }

    if (propertyMeta) {
      return castValue(filter, propertyMeta, cm.getNamespace());
    }

    return filter;
  }

  /**
   * @param {ClassMeta} cm
   * @param {{}} filter
   */
  function prepareFilterValues(cm, filter) {
    return new Promise(function (resolve, reject) {
      var fetchers = [];
      var result = prepareFilterOption(cm, filter, fetchers);
      Promise.all(fetchers).
      then(function () {resolve(result);}).
      catch(reject);
    });
  }

  /**
   * @param {Item} item
   * @returns {Promise}
     */
  function calcProperties(item) {
    return new Promise(function (resolve, reject) {
      var calculations = [];
      var calcNames = [];
      var props = item.getMetaClass().getPropertyMetas();
      for (var i = 0; i < props.length; i++) {
        if (props[i]._formula) {
          calculations.push(props[i]._formula.apply(item, [{}]));
          calcNames.push(props[i].name);
        }
      }

      if (calculations.length === 0) {
        return resolve(item);
      }

      Promise.all(calculations).
      then(function (results) {
        var p;
        for (var i = 0; i < results.length; i++) {
          p = item.property(calcNames[i]);
          item.calculated[calcNames[i]] = results[i];
        }
        resolve(item);
      }).catch(reject);
    });
  }

  function calcItemsProperties(items) {
    return new Promise(function (resolve, reject) {
      var calcs = [];
      for (var i = 0; i < items.length; i++) {
        calcs.push(calcProperties(items[i]));
      }
      Promise.all(calcs).then(function () {
        resolve(items);
      }).catch(reject);
    });
  }

  /**
   * @param {String | Item} obj
   * @param {Object} [options]
   * @param {Object} [options.filter]
   * @param {Number} [options.offset]
   * @param {Number} [options.count]
   * @param {Object} [options.sort]
   * @param {Boolean} [options.countTotal]
   * @param {Number} [options.nestingDepth]
   * @param {String[][]} [options.forceEnrichment]
   * @param {{}} [options.___loaded]
   * @returns {Promise}
   */
  this._getList = function (obj, options) {
    if (!options) {
      options = {};
    }
    var cm = this._getMeta(obj);
    var rcm = this._getRootType(cm);
    options.attributes = ['_class', '_classVer'];
    var props = cm.getPropertyMetas();
    for (var i = 0; i < props.length; i++) {
      options.attributes.push(props[i].name);
    }
    options.filter = this._addFilterByItem(options.filter, obj);
    options.filter = this._addDiscriminatorFilter(options.filter, cm);
    return prepareFilterValues(cm, options.filter).
    then(function (filter) {
      options.filter = filter;
      return _this.ds.fetch(tn(rcm), options);
    }).
    then(
      function (data) {
        var result = [];
        var fl = [];
        try {
          for (var i = 0; i < data.length; i++) {
            result[i] = _this._wrap(data[i]._class, data[i], data[i]._classVer);
            fl.push(loadFiles(result[i]));
          }
        } catch (err) {
          return Promise.reject(err);
        }

        if (typeof data.total !== 'undefined' && data.total !== null) {
          result.total = data.total;
        }
        return Promise.all(fl).then(function () {
          return Promise.resolve(result);
        });
      }
    ).
    then(
      function (result) {
        return enrich(
          result,
          options.nestingDepth ? options.nestingDepth : 0,
          options.forceEnrichment,
          options.___loaded
        );
      }
    ).
    then(calcItemsProperties);
  };

  /**
   * @param {String} className
   * @param {{}} [options]
   * @param {{}} [options.expressions]
   * @param {{}} [options.filter]
   * @param {{}} [options.groupBy]
   * @returns {Promise}
   */
  this._aggregate = function (className, options) {
    if (!options) {
      options = {};
    }
    var cm = this._getMeta(className);
    var rcm = this._getRootType(cm);
    options.filter = this._addDiscriminatorFilter(options.filter, cm);
    return prepareFilterValues(options.filter).
    then(
      function () {
        return _this.ds.aggregate(tn(rcm), options);
      }
    );
  };

  /**
   *
   * @param {String | Item} obj
   * @param {String} [id]
   * @param {{}} [options]
   * @param {Number} [options.nestingDepth]
   * @param {String[][]} [options.forceEnrichment]
   */
  this._getItem = function (obj, id, options) {
    if (id && typeof obj === 'string') {
      return new Promise(function (resolve, reject) {
        var cm = _this._getMeta(obj);
        var rcm = _this._getRootType(cm);
        var conditions = formUpdatedData(rcm, _this.keyProvider.keyToData(rcm.getName(), id, rcm.getNamespace()));
        if (conditions  === null) {
          return resolve(null);
        }
        _this.ds.get(tn(rcm), conditions).then(function (data) {
          var item = null;
          if (data) {
            try {
              item = _this._wrap(data._class, data, data._classVer);
              loadFiles(item).
              then(
                function (item) {
                  return enrich([item], options.nestingDepth || 0, options.forceEnrichment);
                }
              ).
              then(
                function (items) {
                  return calcProperties(items[0]);
                }
              ).
              then(resolve).
              catch(reject);
              return;
            } catch (err) {
              return reject(err);
            }
          }
          resolve(null);
        }).catch(reject);
      });
    } else if (obj instanceof Item) {
      return new Promise(function (resolve, reject) {
        var options = {};
        var cm = obj.getMetaClass();
        var rcm = _this._getRootType(cm);
        options.filter = _this._addFilterByItem({}, obj);
        options.filter = _this._addDiscriminatorFilter(options.filter, cm);
        options.count = 1;
        _this.ds.fetch(tn(rcm), options).then(function (data) {
          var item;
          for (var i = 0; i < data.length; i++) {
            item = _this._wrap(data[i]._class, data[i], data[i]._classVer);
            return loadFiles(item);
          }
          resolve(null);
        }).
        then(function (item) {
          return enrich([item], options.nestingDepth || 0, options.forceEnrichment);
        }).
        then(function (items) {
          return calcProperties(items[0]);
        }).
        then(resolve).
        catch(reject);
      });
    } else {
      throw new Error('Переданы некорректные параметры метода getItem');
    }
  };

  /* jshint maxcomplexity: 20 */
  /**
   * @param {*} value
   * @param {{ type: Number, refClass: String }} pm
   * @param {String} ns
   * @returns {*}
   */
  function castValue(value, pm, ns) {
    if (value === null) {
      return value;
    }
    if (pm.type === PropertyTypes.REFERENCE) {
      if (!value) {
        return null;
      }

      var refkey = pm._refClass.getPropertyMeta(pm._refClass.getKeyProperties()[0]);

      if (refkey) {
        return castValue(value, refkey, ns);
      }
      return value;
    } else if (pm.type === PropertyTypes.BOOLEAN) {
      if (value === null) {
        if (pm.nullable) {
          return null;
        } else {
          return false;
        }
      }
    } else if (value === null) {
      return value;
    }

    return cast(value, pm.type);
  }

  /**
   * @param {ClassMeta} cm
   * @param {Object} data
   * @param {Boolean} setCollections
   * @param {{}} refUpdates
   * @return {Object | null}
   */
  function formUpdatedData(cm, data, setCollections, refUpdates) {
    var updates, pm, nm, dot, tmp;
    updates = {};
    var empty = true;
    for (nm in data) {
      if (data.hasOwnProperty(nm)) {
        empty = false;
        if ((dot = nm.indexOf('.')) >= 0) {
          if (refUpdates) {
            tmp = nm.substring(0, dot);
            pm = cm.getPropertyMeta(tmp);
            if (pm) {
              if (pm.type === PropertyTypes.REFERENCE) {
                if (!refUpdates.hasOwnProperty(tmp)) {
                  refUpdates[tmp] = {};
                }
                refUpdates[tmp][nm.substring(dot + 1)] = data[nm];
              }
            }
          }
        } else {
          pm = cm.getPropertyMeta(nm);
          if (pm) {
            if (pm.type !== PropertyTypes.COLLECTION) {
              data[nm] = castValue(data[nm], pm, cm.namespace);
              if (!(pm.type === PropertyTypes.REFERENCE && pm.backRef)) {
                updates[nm] = data[nm];
              }
            } else if (setCollections && Array.isArray(data[nm]) && !pm.backRef) {
              updates[nm] = data[nm];
            }
          }
        }
      }
    }
    if (empty) {
      return null;
    }
    return updates;
  }

  function fileSaver(updates, pm) {
    return new Promise(function (resolve, reject) {
      var rej = function (err) {
        reject(new Error('Ошибка присвоения файлового атрибута ' + pm.name + ': ' + err.message));
      };
      if (Array.isArray(updates[pm.name])) {
        var savers = [];
        for (var i = 0; i < updates[pm.name].length; i++) {
          if (typeof updates[pm.name][i] !== 'string') {
            savers.push(_this.fileStorage.accept(updates[pm.name][i]));
          }
        }
        if (savers.length) {
          Promise.all(savers).then(
            function (files) {
              if (Array.isArray(files)) {
                updates[pm.name] = [];
                for (var i = 0; i < files.length; i++) {
                  updates[pm.name].push(files[i].id);
                }
              }
              resolve();
            }
          ).catch(rej);
        } else {
          resolve();
        }
      } else {
        var storage = _this.fileStorage;
        if (pm.type === PropertyTypes.IMAGE) {
          storage = _this.imageStorage;
        }
        storage.accept(updates[pm.name]).then(function (f) {
          updates[pm.name] = f.id;
          resolve();
        }).catch(rej);
      }
    });
  }

  /**
   * @param {ClassMeta} cm
   * @param {{}} data
   */
  function checkRequired(cm, data, lazy) {
    var props = cm.getPropertyMetas();
    var invalidAttrs = [];
    for (var i = 0; i < props.length; i++) {
      if (props[i].type !== PropertyTypes.COLLECTION &&
          !props[i].nullable && (
          lazy && data.hasOwnProperty(props[i].name) && data[props[i].name] === null ||
          !lazy && !props[i].autoassigned && (!data.hasOwnProperty(props[i].name) || data[props[i].name] === null)
        )) {
        invalidAttrs.push(cm.getCaption() + '.' + props[i].caption);
      }
    }
    if (invalidAttrs.length) {
      return new Error('Не заполнены обязательные атрибуты: ' + invalidAttrs.join(', '));
    }
    return true;
  }

  /**
   * @param {ClassMeta} cm
   * @param {{}} updates
   */
  function autoAssign(cm, updates, onlyDefaults) {
    if (cm.getCreationTracker() && !updates[cm.getCreationTracker()]) {
      updates[cm.getCreationTracker()] = new Date();
    }

    if (cm.getChangeTracker() && !updates[cm.getChangeTracker()]) {
      updates[cm.getChangeTracker()] = new Date();
    }

    var properties = cm.getPropertyMetas();
    var keys = cm.getKeyProperties();
    var pm;

    for (var i = 0;  i < properties.length; i++) {
      pm = properties[i];

      if (typeof updates[pm.name] === 'undefined') {
        if (pm.type === PropertyTypes.COLLECTION && !pm.backRef) {
          updates[pm.name] = [];
          continue;
        }

        if (pm.autoassigned && !onlyDefaults) {
          switch (pm.type) {
            case PropertyTypes.STRING:
            case PropertyTypes.GUID: {
              updates[pm.name] = uuid.v1();
            }
              break;
            case PropertyTypes.DATETIME: {
              updates[pm.name] = new Date();
            }
              break;
            case PropertyTypes.INT: {
              delete updates[pm.name];
            }
              break;
          }
        } else if (pm.defaultValue !== null && pm.defaultValue !== '') {
          try {
            updates[pm.name] = cast(pm.defaultValue, pm.type);
          } catch (err) {
          }
        } else if (keys.indexOf(pm.name) >= 0 && !onlyDefaults) {
          throw new Error('Не указано значение ключевого атрибута ' + cm.getCaption() + '.' + pm.caption);
        }
      }
    }
  }

  function prepareFileSavers(cm, fileSavers, updates) {
    var properties = cm.getPropertyMetas();
    var pm;
    for (var i = 0;  i < properties.length; i++) {
      pm = properties[i];

      if (updates.hasOwnProperty(pm.name) && updates[pm.name] &&
        (
          (pm.type === PropertyTypes.FILE || pm.type === PropertyTypes.IMAGE) &&
          typeof updates[pm.name] !== 'string' && !Array.isArray(updates[pm.name]) ||
          pm.type === PropertyTypes.FILE_LIST && Array.isArray(updates[pm.name])
        )
      ) {
        fileSavers.push(fileSaver(updates, pm));
      }
    }
  }

  /**
   * @param {String} itemId
   * @param {{}} pm
   * @param {{}} updates
   * @param {ClassMeta} cm
   * @param {String} oldId
   * @returns {Promise}
   */
  function backRefUpdater(itemId, pm, updates, cm, oldId) {
    return new Promise(function (resolve, reject) {
      var rcm = _this.meta.getMeta(pm.refClass, cm.getVersion(), cm.getNamespace());
      var rpm = rcm.getPropertyMeta(pm.backRef);

      if (!rpm) {
        return reject(new Error('По обратной ссылке ' + cm.getCaption() + '.' + pm.caption +
          ' не найден атрибут ' + rcm.getCaption() + '.' + pm.backRef));
      }

      var clr = {};
      var clrf = {$and: []};
      var ups = {};
      var conds = {};
      var tmp;

      conds[rcm.getKeyProperties()[0]] = updates[pm.name];

      tmp = {};
      tmp[pm.backRef] = oldId || itemId;
      clrf.$and.push(tmp);

      tmp = {};
      tmp[rcm.getKeyProperties()[0]] = {$ne: updates[pm.name]};
      clrf.$and.push(tmp);

      clrf[pm.backRef] = oldId || itemId;
      clr[pm.backRef] = null;
      ups[pm.backRef] = itemId;

      if (oldId) {
        if (!rpm.nullable) {
          if (options.log) {
            options.log.warn('Невозможно отвязать объект по ссылке "' + pm.caption + '"');
          }
        } else {
          return options.dataSource.update(tn(rcm), clrf, clr, false, true).then(function (r) {
            return options.dataSource.update(tn(rcm), conds, ups);
          }).then(resolve).catch(reject);
        }
      }

      options.dataSource.update(tn(rcm), conds, ups).then(resolve).catch(reject);
    });
  }

  /**
   * @param {Item} item
   * @param {ClassMeta} cm
   * @param {{}} updates
   * @param {String} oldId
   */
  function updateBackRefs(item, cm, updates, oldId) {
    return new Promise(function (resolve, reject) {
      var properties = cm.getPropertyMetas();
      var workers = [];
      var pm, i;
      for (i = 0;  i < properties.length; i++) {
        pm = properties[i];
        if (
          updates.hasOwnProperty(pm.name) &&
          pm.type === PropertyTypes.REFERENCE &&
          pm.backRef
        ) {
          workers.push(backRefUpdater(item.getItemId(), pm, updates, cm, oldId));
        }
      }
      Promise.all(workers).
      then(
        function () {
          resolve(item);
        }
      ).catch(reject);
    });
  }

  /**
   * @param {ChangeLogger | Function} changeLogger
   * @param {{}} record
   * @param {String} record.type
   * @param {Item} [record.item]
   * @param {ClassMeta} [record.cm]
   * @param {{}} [record.updates]
   * @returns {Promise}
   */
  function logChanges(changeLogger, record) {
    return new Promise(function (resolve, reject) {
      var p;
      if (changeLogger instanceof ChangeLogger) {
        p = changeLogger.LogChange(
          record.type,
          record.item.getMetaClass().getCanonicalName(),
          record.item.getItemId(),
          record.updates
        );
      } else if (typeof changeLogger === 'function') {
        p = changeLogger(record);
      }

      if (p instanceof Promise) {
        p.then(function () {
          resolve(record.item);
        }).catch(reject);
        return;
      }

      resolve(record.item);
    });
  }

  /**
   * @param {Item} item
   * @param {{}} refUpdates
   */
  function refUpdator(item, refUpdates, changeLogger) {
    return new Promise(function (resolve, reject) {
      var savers = [];
      var p, rm, id;
      var needSetRef = {};
      for (var nm in refUpdates) {
        if (refUpdates.hasOwnProperty(nm)) {
          p = item.property(nm);
          if (p) {
            rm = _this.meta.getMeta(
              p.meta.refClass,
              item.getMetaClass().getVersion(),
              item.getMetaClass().getNamespace()
            );
            id = item.get(nm);
            if (!id) {
              needSetRef[nm] = savers.length;
            }
            savers.push(
              _this._saveItem(
                rm.getCanonicalName(),
                id,
                refUpdates[nm],
                rm.getVersion(),
                changeLogger
              )
            );
          }
        }
      }
      if (savers.length === 0) {
        return resolve(item);
      }

      Promise.all(savers).then(function (savedRefs) {
        var setRefs = false;
        for (var nm in needSetRef) {
          if (needSetRef.hasOwnProperty(nm)) {
            needSetRef[nm] = savedRefs[needSetRef[nm]].getItemId();
            setRefs = true;
          }
        }
        if (setRefs) {
          _this._editItem(
            item.getMetaClass().getCanonicalName(),
            item.getItemId(),
            needSetRef,
            changeLogger
          ).then(resolve).catch(reject);
          return;
        }
        resolve(item);
      }).
      catch(reject);
    });
  }

  function writeEventHandler(nestingDepth, changeLogger) {
    return function (e) {
      var up = false;
      var data = {};
      if (Array.isArray(e.results) && e.results.length) {
        for (var i = 0; i < e.results.length; i++) {
          for (var nm in e.results[i]) {
            if (e.results[i].hasOwnProperty(nm)) {
              up = true;
              data[nm] = e.results[i][nm];
            }
          }
        }
      }
      if (up) {
        return _this._editItem(
          e.item.getMetaClass().getCanonicalName(),
          e.item.getItemId(),
          data,
          changeLogger,
          {nestingDepth: nestingDepth},
          true
        );
      }
      return enrich(e.item, nestingDepth);
    };
  }

  /**
   *
   * @param {String} classname
   * @param {Object} data
   * @param {String} [version]
   * @param {ChangeLogger | Function} [changeLogger]
   * @param {{}} [options]
   * @param {Number} [options.nestingDepth]
   * @returns {Promise}
   */
  this._createItem = function (classname, data, version, changeLogger, options) {
    options = options || {};
    // jshint maxcomplexity: 30
    return new Promise(function (resolve, reject) {
      try {
        var cm = _this.meta.getMeta(classname, version);
        var rcm = _this._getRootType(cm);

        var refUpdates = {};
        var updates = formUpdatedData(cm, data, true, refUpdates) || {};

        var fileSavers = [];

        autoAssign(cm, updates);
        prepareFileSavers(cm, fileSavers, updates);
        var chr = checkRequired(cm, updates, false);
        if (chr !== true) {
          return reject(chr);
        }

        Promise.all(fileSavers).then(function () {
          updates._class = cm.getCanonicalName();
          updates._classVer = cm.getVersion();
          return _this.ds.insert(tn(rcm), updates);
        }).then(function (data) {
          var item = _this._wrap(data._class, data, data._classVer);
          return logChanges(changeLogger, {type: EventType.CREATE, item: item, updates: updates});
        }).then(function (item) {
          return updateBackRefs(item, cm, data);
        }).then(function (item) {
          return refUpdator(item, refUpdates, changeLogger);
        }).then(function (item) {
          return loadFiles(item);
        }).then(function (item) {
          return _this.trigger({
            type: item.getMetaClass().getCanonicalName() + '.create',
            item: item,
            data: data
          });
        }).
        then(writeEventHandler(options.nestingDepth, changeLogger)).
        then(
          function (item) {
            return calcProperties(item);
          }
        ).then(resolve).catch(reject);
      } catch (err) {
        reject(err);
      }
    });
  };

  /**
   *
   * @param {String} classname
   * @param {String} id
   * @param {{}} data
   * @param {ChangeLogger} [changeLogger]
   * @param {{}} [options]
   * @param {Number} [options.nestingDepth]
   * @param {Boolean} [suppresEvent]
   * @returns {Promise}
   */
  this._editItem = function (classname, id, data, changeLogger, options, suppresEvent) {
    options = options || {};
    return new Promise(function (resolve, reject) {
      if (!id) {
        return reject(new Error('Не передан идентификатор объекта!'));
      }
      try {
        var cm = _this.meta.getMeta(classname);
        var rcm = _this._getRootType(cm);

        /**
         * @var {{}}
         */
        var conditions = formUpdatedData(rcm, _this.keyProvider.keyToData(rcm.getCanonicalName(), id));

        if (conditions) {
          var refUpdates = {};
          var updates = formUpdatedData(cm, data, false, refUpdates) || {};

          var fileSavers = [];

          if (cm.getChangeTracker()) {
            updates[cm.getChangeTracker()] = new Date();
          }

          prepareFileSavers(cm, fileSavers, updates);
          var chr = checkRequired(cm, updates, true);
          if (chr !== true) {
            return reject(chr);
          }

          Promise.all(fileSavers).then(function () {
            return _this.ds.update(tn(rcm), conditions, updates);
          }).then(function (data) {
            if (!data) {
              return reject(new Error('Не найден объект для редактирования ' + cm.getName() + '@' + id));
            }
            var item = _this._wrap(data._class, data, data._classVer);
            return logChanges(changeLogger, {type: EventType.UPDATE, item: item, updates: updates});
          }).then(function (item) {
            return updateBackRefs(item, cm, data, id);
          }).then(function (item) {
            return refUpdator(item, refUpdates, changeLogger);
          }).then(function (item) {
            return loadFiles(item);
          }).then(function (item) {
            if (!suppresEvent) {
              return _this.trigger({
                type: item.getMetaClass().getCanonicalName() + '.edit',
                item: item,
                updates: data
              });
            }
            return new Promise(function (resolve) {resolve({item: item});});
          }).
          then(writeEventHandler(options.nestingDepth, changeLogger)).
          then(
            function (item) {
              return calcProperties(item);
            }
          ).
          then(resolve).catch(reject);
        } else {
          reject({Error: 'Не указан идентификатор объекта!'});
        }
      } catch (err) {
        reject(err);
      }
    });
  };

  /**
   *
   * @param {String} classname
   * @param {String} id
   * @param {{}} data
   * @param {String} [version]
   * @param {ChangeLogger} [changeLogger]
   * @param {{}} [options]
   * @param {Number} [options.nestingDepth]
   * @param {Boolean} [options.autoAssign]
   * @param {Boolean} [options.ignoreIntegrityCheck]
   * @returns {Promise}
   */
  this._saveItem = function (classname, id, data, version, changeLogger, options) {
    options = options || {};
    return new Promise(function (resolve, reject) {
      var fileSavers = [];
      try {
        var cm = _this.meta.getMeta(classname, version);
        var rcm = _this._getRootType(cm);

        var refUpdates = {};
        var updates = formUpdatedData(cm, data, true, refUpdates) || {};
        var conditionsData;

        if (id) {
          conditionsData = _this.keyProvider.keyToData(rcm.getName(), id, rcm.getNamespace());
        } else {
          conditionsData = _this.keyProvider.keyData(rcm.getName(), updates, rcm.getNamespace());
        }

        var event = EventType.UPDATE;

        prepareFileSavers(cm, fileSavers, updates);

        Promise.all(fileSavers).then(function () {
          var chr;
          try {
            updates._class = cm.getCanonicalName();
            updates._classVer = cm.getVersion();
            if (conditionsData) {
              var conditions = formUpdatedData(rcm, conditionsData);
              if (options && options.autoAssign) {
                autoAssign(cm, updates);
              } else {
                if (cm.getChangeTracker()) {
                  updates[cm.getChangeTracker()] = new Date();
                }
              }
              chr = checkRequired(cm, updates, id ? true : false);
              if (chr !== true && options.ignoreIntegrityCheck) {
                console.error('Ошибка контроля целостности сохраняемого объекта', chr.message);
                chr = true;// Если задано игнорировать целостность - игнорируем
              }
              return chr !== true ? reject(chr) : _this.ds.upsert(tn(rcm), conditions, updates); // TODO передавать игнорирование целостности
            } else {
              autoAssign(cm, updates);
              event = EventType.CREATE;
              chr = checkRequired(cm, updates, false);
              if (chr !== true && options.ignoreIntegrityCheck) {
                console.error('Ошибка контроля целостности сохраняемого объекта', chr.message);
                chr = true;// Если задано игнорировать целостность - игнорируем
              }
              return chr !== true ? reject(chr) : _this.ds.insert(tn(rcm), updates); // TODO передавать игнорирование целостности
            }
          } catch (err) {
            reject(err);
          }
        }).then(function (data) {
          var item = _this._wrap(data._class, data, data._classVer);
          return logChanges(changeLogger, {type: event, item: item, updates: updates});
        }).then(function (item) {
          if (!options.ignoreIntegrityCheck) {
            return updateBackRefs(item, cm, data, id || item.getItemId());
          } else {
            return item;
          }
        }).then(function (item) {
          if (!options.ignoreIntegrityCheck) {
            return refUpdator(item, refUpdates, changeLogger);
          } else {
            return item;
          }
        }).then(function (item) {
          return loadFiles(item);
        }).then(function (item) {
          return _this.trigger({
            type: item.getMetaClass().getCanonicalName() + '.save',
            item: item,
            updates: data
          });
        }).
        then(writeEventHandler(options.nestingDepth, changeLogger)).
        then(
          function (item) {
            return calcProperties(item);
          }
        ).then(resolve).catch(reject);
      } catch (err) {
        return reject(err);
      }
    });
  };

  /**
   *
   * @param {String} classname
   * @param {String} id
   * @param {ChangeLogger} [changeLogger]
   * @param {{}} [options]
   */
  this._deleteItem = function (classname, id, changeLogger, options) {
    var cm = _this.meta.getMeta(classname);
    var rcm = _this._getRootType(cm);
    // TODO Каким-то образом реализовать извлечение из всех возможных коллекций
    return new Promise(function (resolve, reject) {
      var conditions = formUpdatedData(rcm, _this.keyProvider.keyToData(rcm.getName(), id, rcm.getNamespace()));
      var item = _this._wrap(classname, conditions);
      _this.ds.delete(tn(rcm), conditions).
      then(function () {
        return logChanges(changeLogger, {type: EventType.DELETE, item: item, updates: {}});
      }).
      then(
        function () {
          return _this.trigger({
            type: classname + '.delete',
            id: id
          });
        }
      ).
      then(function () {
        resolve();
      }).
      catch(reject);
    });
  };

  /**
   * @param {Item[]} masters
   * @param {String[]} collections
   * @param {Item[]} details
   * @param {String} action - 'put' или 'eject' - вставка или извлечение
   * @returns {Promise}
   */
  function editCollections(masters, collections, details, action) {
    return new Promise(function (resolve, reject) {
      var getters = [];
      for (var i = 0; i < masters.length; i++) {
        getters.push(_this._getItem(masters[i].getMetaClass().getCanonicalName(), masters[i].getItemId(), 0));
      }

      Promise.all(getters).
      then(function (m) {
        var writers = [];
        var i, j, k, cond, updates, act, src, mrcm;
        for (i = 0; i < m.length; i++) {
          if (m[i]) {
            cond = formUpdatedData(
              m[i].getMetaClass(),
              _this.keyProvider.keyToData(
                m[i].getMetaClass().getName(),
                m[i].getItemId(),
                m[i].getMetaClass().getNamespace())
            );
            updates = {};
            act = false;
            for (k = 0; k < collections.length; k++) {
              src = m[i].base[collections[k]] || [];
              for (j = 0; j < details.length; j++) {
                if (details[j]) {
                  if (action === 'eject') {
                    src.splice(src.indexOf(details[j].getItemId()), 1);
                  } else if (src.indexOf(details[j].getItemId()) < 0) {
                    src.push(details[j].getItemId());
                  }
                }
              }
              updates[collections[k]] = src;
              act = true;
            }
            if (act) {
              mrcm = _this._getRootType(m[i].getMetaClass());
              writers.push(_this.ds.update(tn(mrcm), cond, updates));
            }
          }
        }
        return Promise.all(writers);
      }).
      then(resolve).
      catch(reject);
    });
  }

  /**
   * @param {Item} master
   * @param {String} collection
   * @param {Item[]} details
   * @param {ChangeLogger} [changeLogger]
   * @returns {*}
   * @private
   */
  function _editCollection(master, collection, details, changeLogger, operation) {
    return new Promise(function (resolve, reject) {
      var pm = master.getMetaClass().getPropertyMeta(collection);
      if (!pm || pm.type !== PropertyTypes.COLLECTION) {
        return reject(new Error('Не найден атрибут коллекции ' + master.getClassName() + '.' + collection));
      }

      var event = master.getMetaClass().getCanonicalName() + '.' + collection + '.' + (operation ? 'put' : 'eject');

      if (pm.backRef) {
        var update = {};
        update[pm.backRef] = operation ? (pm.binding ? master.get(pm.binding) : master.getItemId()) : null;

        var writers = [];
        for (var i = 0; i < details.length; i++) {
          writers.push(_this._editItem(details[i].getMetaClass().getCanonicalName(), details[i].getItemId(), update));
        }

        Promise.all(writers).then(function () {
          return _this.trigger({
            type: event,
            master: master,
            details: details
          });
        }).then(function () {resolve();}).catch(reject);
      } else {
        editCollections([master], [collection], details, operation ? 'put' : 'eject').
        then(function () {
          var i;
          if (pm.backColl) {
            var colls = [];
            for (i = 0; i < details.length; i++) {
              var bcpm = details[i].getMetaClass().getPropertyMeta(pm.backColl);
              if (bcpm.type === PropertyTypes.COLLECTION) {
                colls.push(bcpm.name);
              }
            }
            if (colls.length === 0) {
              return new Promise(function (r) {
                r();
              });
            }
            return editCollections(details, colls, [master], operation ? 'put' : 'eject');
          } else {
            var props;
            var backColls = [];
            var parsed = {};
            for (i = 0; i < details.length; i++) {
              if (!parsed.hasOwnProperty(details[i].getClassName())) {
                props = details[i].getMetaClass().getPropertyMetas();
                for (var j = 0; j < props.length; j++) {
                  if (props[j].type === PropertyTypes.COLLECTION && props[j].backColl === collection) {
                    backColls.push(props[j].name);
                  }
                }
                parsed[details[i].getClassName()] = true;
              }
            }
            if (backColls.length === 0) {
              return new Promise(function (r) {
                r();
              });
            }
            return editCollections(details, backColls, [master], operation ? 'put' : 'eject');
          }
        }).then(function () {
          var updates = {};
          updates[collection] = [];
          for (var i = 0; i < details.length; i++) {
            updates[collection].push({
              className: details[i].getMetaClass().getCanonicalName(),
              id: details[i].getItemId()
            });
          }
          return logChanges(
            changeLogger,
            {
              type: operation ? EventType.PUT : EventType.EJECT,
              item: master,
              updates: updates
            }
          );
        }).
        then(function () {
          return _this.trigger({type: event, master: master, details: details});
        }).
        then(function () {resolve();}).
        catch(reject);
      }
    });
  }

  /**
   *
   * @param {Item} master
   * @param {String} collection
   * @param {Item[]} details
   * @param {ChangeLogger} [changeLogger]
   * @param {{}} [options]
   * @returns {Promise}
   */
  this._put = function (master, collection, details, changeLogger, options) {
    return _editCollection(master, collection, details, changeLogger, true);
  };

  /**
   *
   * @param {Item} master
   * @param {String} collection
   * @param {Item[]} details
   * @param {ChangeLogger} [changeLogger]
   * @param {{}} [options]
   * @returns {Promise}
   */
  this._eject = function (master, collection, details, changeLogger, options) {
    return _editCollection(master, collection, details, changeLogger, false);
  };

  /**
   * @param {Item} master
   * @param {String} collection
   * @param {{}} options
   * @param {Boolean} onlyCount - определяте получаемы результат, если true то только считаем количество
   * @returns {*}
   */
  function getCollection(master, collection, options, onlyCount) {
    return new Promise(function (resolve, reject) {
      var filter;

      if (!options) {
        options = {};
      }

      var pm = master.getMetaClass().getPropertyMeta(collection);
      if (!pm) {
        return reject(new Error('Не найден атрибут коллекции ' + master.getClassName() + '.' + collection));
      }

      var detailCm = _this.meta.getMeta(pm.itemsClass, null, master.getMetaClass().getNamespace());
      if (!detailCm) {
        return reject(new Error('Не найден класс элементов коллекции!'));
      }

      if (pm.backRef) {
        filter = {};
        filter[pm.backRef] = pm.binding ? master.get(pm.binding) : master.getItemId();
        if (pm.selConditions) {
          var tmp = ConditionParser(pm.selConditions, pm._refClass, master);
          if (tmp) {
            filter = {$and: [filter, tmp]};
          }
        }
        options.filter = options.filter ? {$and: [filter, options.filter]} : filter;
        _this._getList(detailCm.getCanonicalName(), options).then(resolve).catch(reject);
      } else {
        var key = null;
        var kp = detailCm.getKeyProperties();
        if (kp.length > 1) {
          reject(new Error('Коллекции многие-ко-многим на составных ключах не поддерживаются!'));
        }

        filter = {};
        console.log(master.base[collection]);
        filter[kp[0]] = {$in: master.base[collection] || []};
        options.filter = options.filter ? {$and: [options.filter, filter]} : filter;
        if (onlyCount) {
          _this._getCount(detailCm.getCanonicalName(), options).then(resolve).catch(reject);
        } else {
          _this._getList(detailCm.getCanonicalName(), options).then(resolve).catch(reject);
        }
      }
    });
  }

  /**
   * @param {Item} master
   * @param {String} collection
   * @param {Object} [options]
   * @param {Object} [options.filter]
   * @param {Number} [options.offset]
   * @param {Number} [options.count]
   * @param {Object} [options.sort]
   * @param {Boolean} [options.countTotal]
   * @param {Number} [options.nestingDepth]
   * @returns {Promise}
   */
  this._getAssociationsList = function (master, collection, options) {
    return getCollection(master, collection, options, false);
  };

  /**
   *
   * @param {Item} master
   * @param {String} collection
   * @param {{filter: Object}} [options]
   * @returns {Promise}
   */
  this._getAssociationsCount = function (master, collection, options) {
    return getCollection(master, collection, options, true);
  };
}

IonDataRepository.prototype = new DataRepository();
module.exports = IonDataRepository;
