// Copyright (c) 2009-2011 by Kris Maglione <maglione.k@gmail.com>
//
// This work is licensed for reuse under an MIT license. Details are
// given in the LICENSE.txt file included with this file.
"use strict";

try {

Components.utils.import("resource://dactyl/bootstrap.jsm");
defineModule("overlay", {
    exports: ["ModuleBase", "overlay"],
    require: ["config", "help", "highlight", "io", "services", "util"]
}, this);

/**
 * @class ModuleBase
 * The base class for all modules.
 */
var ModuleBase = Class("ModuleBase", {
    /**
     * @property {[string]} A list of module prerequisites which
     * must be initialized before this module is loaded.
     */
    requires: [],

    toString: function () "[module " + this.constructor.className + "]"
});

var getAttr = function getAttr(elem, ns, name)
    elem.hasAttributeNS(ns, name) ? elem.getAttributeNS(ns, name) : null;
var setAttr = function setAttr(elem, ns, name, val) {
    if (val == null)
        elem.removeAttributeNS(ns, name);
    else
        elem.setAttributeNS(ns, name, val);
}


var Overlay = Module("Overlay", XPCOM([Ci.nsIObserver, Ci.nsISupportsWeakReference]), {
    init: function init() {
        util.addObserver(this);
        this.overlays = {};

        this.onWindowVisible = [];

        config.loadStyles();

        this.timeout(this.initialize);
    },

    id: Class.Memoize(function () config.addon.id),

    initialize: function () {
        this.overlayWindow(config.overlayChrome, function _overlay(window) ({
            init: function onInit(document) {
                /**
                 * @constructor Module
                 *
                 * Constructs a new ModuleBase class and makes arrangements for its
                 * initialization. Arguments marked as optional must be either
                 * entirely elided, or they must have the exact type specified.
                 * Loading semantics are as follows:
                 *
                 *  - A module is guaranteed not to be initialized before any of its
                 *    prerequisites as listed in its {@see ModuleBase#requires} member.
                 *  - A module is considered initialized once it's been instantiated,
                 *    its {@see Class#init} method has been called, and its
                 *    instance has been installed into the top-level {@see modules}
                 *    object.
                 *  - Once the module has been initialized, its module-dependent
                 *    initialization functions will be called as described hereafter.
                 * @param {string} name The module's name as it will appear in the
                 *     top-level {@see modules} object.
                 * @param {ModuleBase} base The base class for this module.
                 *     @optional
                 * @param {Object} prototype The prototype for instances of this
                 *     object. The object itself is copied and not used as a prototype
                 *     directly.
                 * @param {Object} classProperties The class properties for the new
                 *     module constructor.
                 *     @optional
                 * @param {Object} moduleInit The module initialization functions
                 *     for the new module. Each function is called as soon as the named module
                 *     has been initialized, but after the module itself. The constructors are
                 *     guaranteed to be called in the same order that the dependent modules
                 *     were initialized.
                 *     @optional
                 *
                 * @returns {function} The constructor for the resulting module.
                 */
                function Module(name) {
                    let args = Array.slice(arguments);

                    var base = ModuleBase;
                    if (callable(args[1]))
                        base = args.splice(1, 1)[0];
                    let [, prototype, classProperties, moduleInit] = args;
                    const module = Class(name, base, prototype, classProperties);

                    module.INIT = moduleInit || {};
                    module.modules = modules;
                    module.prototype.INIT = module.INIT;
                    module.requires = prototype.requires || [];
                    Module.list.push(module);
                    Module.constructors[name] = module;
                    return module;
                }
                Module.list = [];
                Module.constructors = {};

                const BASE = "resource://dactyl-content/";

                const create = window.Object.create || (function () {
                    window.__dactyl_eval_string = "(function (proto) ({ __proto__: proto }))";
                    JSMLoader.loadSubScript(BASE + "eval.js", window);

                    let res = window.__dactyl_eval_result;
                    delete window.__dactyl_eval_string;
                    delete window.__dactyl_eval_result;
                    return res;
                })();

                const jsmodules = { NAME: "jsmodules" };
                const modules = update(create(jsmodules), {
                    yes_i_know_i_should_not_report_errors_in_these_branches_thanks: [],

                    jsmodules: jsmodules,

                    get content() this.config.browser.contentWindow || window.content,

                    window: window,

                    Module: Module,

                    load: function load(script) {
                        for (let [i, base] in Iterator(prefix)) {
                            try {
                                JSMLoader.loadSubScript(base + script + ".js", modules, "UTF-8");
                                return;
                            }
                            catch (e) {
                                if (typeof e !== "string") {
                                    util.dump("Trying: " + (base + script + ".js") + ":");
                                    util.reportError(e);
                                }
                            }
                        }
                        try {
                            require(jsmodules, script);
                        }
                        catch (e) {
                            util.dump("Loading script " + script + ":");
                            util.reportError(e);
                        }
                    },

                    newContext: function newContext(proto, normal) {
                        if (normal)
                            return create(proto);
                        let sandbox = Components.utils.Sandbox(window, { sandboxPrototype: proto || modules, wantXrays: false });
                        // Hack:
                        sandbox.Object = jsmodules.Object;
                        sandbox.Math = jsmodules.Math;
                        sandbox.__proto__ = proto || modules;
                        return sandbox;
                    },

                    get ownPropertyValues() array.compact(
                            Object.getOwnPropertyNames(this)
                                  .map(function (name) Object.getOwnPropertyDescriptor(this, name).value, this)),

                    get moduleList() this.ownPropertyValues.filter(function (mod) mod instanceof this.ModuleBase || mod.isLocalModule, this)
                });
                modules.plugins = create(modules);
                modules.modules = modules;
                window.dactyl = { modules: modules };

                let prefix = [BASE, "resource://dactyl-local-content/"];

                defineModule.time("load", null, function _load() {
                    config.modules.global
                          .forEach(function (name) defineModule.time("load", name, require, null, jsmodules, name));

                    config.modules.window
                          .forEach(function (name) defineModule.time("load", name, modules.load, modules, name));
                }, this);
            },
            load: function onLoad(document) {
                // This is getting to be horrible. --Kris

                var { modules, Module } = window.dactyl.modules;
                delete window.dactyl;

                this.startTime = Date.now();
                const deferredInit = { load: {} };
                const seen = Set();
                const loaded = Set();
                modules.loaded = loaded;

                function load(module, prereq, frame) {
                    if (isString(module)) {
                        if (!Module.constructors.hasOwnProperty(module))
                            modules.load(module);
                        module = Module.constructors[module];
                    }

                    try {
                        if (module.className in loaded)
                            return;
                        if (module.className in seen)
                            throw Error("Module dependency loop.");
                        Set.add(seen, module.className);

                        for (let dep in values(module.requires))
                            load(Module.constructors[dep], module.className);

                        defineModule.loadLog.push("Load" + (isString(prereq) ? " " + prereq + " dependency: " : ": ") + module.className);
                        if (frame && frame.filename)
                            defineModule.loadLog.push(" from: " + util.fixURI(frame.filename) + ":" + frame.lineNumber);

                        let obj = defineModule.time(module.className, "init", module);
                        Class.replaceProperty(modules, module.className, obj);
                        loaded[module.className] = true;

                        if (loaded.dactyl && obj.signals)
                            modules.dactyl.registerObservers(obj);

                        frob(module.className);
                    }
                    catch (e) {
                        util.dump("Loading " + (module && module.className) + ":");
                        util.reportError(e);
                    }
                    return modules[module.className];
                }

                function deferInit(name, INIT, mod) {
                    let init = deferredInit[name] = deferredInit[name] || {};
                    let className = mod.className || mod.constructor.className;

                    init[className] = function callee() {
                        if (!callee.frobbed)
                            defineModule.time(className, name, INIT[name], mod,
                                              modules.dactyl, modules, window);
                        callee.frobbed = true;
                    };

                    INIT[name].require = function (name) { init[name](); };
                }

                function frobModules() {
                    Module.list.forEach(function frobModule(mod) {
                        if (!mod.frobbed) {
                            modules.__defineGetter__(mod.className, function () {
                                delete modules[mod.className];
                                return load(mod.className, null, Components.stack.caller);
                            });
                            Object.keys(mod.prototype.INIT)
                                  .forEach(function (name) { deferInit(name, mod.prototype.INIT, mod); });
                        }
                        mod.frobbed = true;
                    });
                }
                defineModule.modules.forEach(function defModule(mod) {
                    let names = Set(Object.keys(mod.INIT));
                    if ("init" in mod.INIT)
                        Set.add(names, "init");

                    keys(names).forEach(function (name) { deferInit(name, mod.INIT, mod); });
                });

                function frob(name) { values(deferredInit[name] || {}).forEach(call); }
                this.frob = frob;
                this.modules = modules;

                frobModules();
                frob("init");

                modules.config.scripts.forEach(modules.load);

                frobModules();

                defineModule.modules.forEach(function defModule({ lazyInit, constructor: { className } }) {
                    if (!lazyInit) {
                        frob(className);
                        Class.replaceProperty(modules, className, modules[className]);
                    }
                    else
                        modules.__defineGetter__(className, function () {
                            delete modules[className];
                            frob(className);
                            return modules[className] = modules[className];
                        });
                });

                modules.events.listen(window, "unload", function onUnload() {
                    window.removeEventListener("unload", onUnload.wrapped, false);

                    overlay.windows = overlay.windows.filter(function (w) w != window);

                    for each (let mod in modules.moduleList.reverse()) {
                        mod.stale = true;

                        if ("destroy" in mod)
                            util.trapErrors("destroy", mod);
                    }
                }, false);
            },
            visible: function visible(window) {
                // Module.list.forEach(load);
                this.frob("load");
                this.modules.times = update({}, defineModule.times);

                defineModule.loadLog.push("Loaded in " + (Date.now() - this.startTime) + "ms");

                overlay.windows = array.uniq(overlay.windows.concat(window), true);
            }
        }));
    },

    cleanup: function cleanup() {
        for (let doc in util.iterDocuments()) {
            for (let elem in values(this.getData(doc, "overlayElements")))
                if (elem.parentNode)
                    elem.parentNode.removeChild(elem);

            for (let [elem, ns, name, orig, value] in values(this.getData(doc, "overlayAttributes")))
                if (getAttr(elem, ns, name) === value)
                    setAttr(elem, ns, name, orig);

            delete doc[this.id];
            delete doc.defaultView[this.id];
        }
    },

    observers: {
        "toplevel-window-ready": function (window, data) {
            window.addEventListener("DOMContentLoaded", util.wrapCallback(function listener(event) {
                if (event.originalTarget === window.document) {
                    window.removeEventListener("DOMContentLoaded", listener.wrapper, true);
                    overlay._loadOverlays(window);
                }
            }), true);
        },
        "chrome-document-global-created": function (window, uri) { this.observe(window, "toplevel-window-ready", null); },
        "content-document-global-created": function (window, uri) { this.observe(window, "toplevel-window-ready", null); },
        "xul-window-visible": function () {
            if (this.onWindowVisible)
                this.onWindowVisible.forEach(function (f) f.call(this), this);
            this.onWindowVisible = null;
        }
    },

    getData: function getData(obj, key, constructor) {
        let { id } = this;

        if (!(id in obj))
            obj[id] = {};

        if (!(key in obj[id]))
            obj[id][key] = (constructor || Array)();

        return obj[id][key];
    },

    setData: function setData(obj, key, val) {
        let { id } = this;

        if (!(id in obj))
            obj[id] = {};

        return obj[id][key] = val;
    },

    overlayWindow: function (url, fn) {
        if (url instanceof Ci.nsIDOMWindow)
            overlay._loadOverlay(url, fn);
        else {
            Array.concat(url).forEach(function (url) {
                if (!this.overlays[url])
                    this.overlays[url] = [];
                this.overlays[url].push(fn);
            }, this);

            for (let doc in util.iterDocuments())
                if (~["interactive", "complete"].indexOf(doc.readyState)) {
                    this.observe(doc.defaultView, "xul-window-visible");
                    this._loadOverlays(doc.defaultView);
                }
                else {
                    if (!this.onWindowVisible)
                        this.onWindowVisible = [];
                    this.observe(doc.defaultView, "toplevel-window-ready");
                }
        }
    },

    _loadOverlays: function _loadOverlays(window) {
        let overlays = this.getData(window, "overlays");

        for each (let obj in overlay.overlays[window.document.documentURI] || []) {
            if (~overlays.indexOf(obj))
                continue;
            overlays.push(obj);
            this._loadOverlay(window, obj(window));
        }
    },

    _loadOverlay: function _loadOverlay(window, obj) {
        let doc = window.document;
        let elems = this.getData(doc, "overlayElements");
        let attrs = this.getData(doc, "overlayAttributes");

        function insert(key, fn) {
            if (obj[key]) {
                let iterator = Iterator(obj[key]);
                if (!isObject(obj[key]))
                    iterator = ([elem.@id, elem.elements(), elem.@*::*.(function::name() != "id")] for each (elem in obj[key]));

                for (let [elem, xml, attr] in iterator) {
                    if (elem = doc.getElementById(elem)) {
                        let node = util.xmlToDom(xml, doc, obj.objects);
                        if (!(node instanceof Ci.nsIDOMDocumentFragment))
                            elems.push(node);
                        else
                            for (let n in array.iterValues(node.childNodes))
                                elems.push(n);

                        fn(elem, node);
                        for each (let attr in attr || []) {
                            let ns = attr.namespace(), name = attr.localName();
                            attrs.push([elem, ns, name, getAttr(elem, ns, name), String(attr)]);
                            if (attr.name() != "highlight")
                                elem.setAttributeNS(ns, name, String(attr));
                            else
                                highlight.highlightNode(elem, String(attr));
                        }
                    }
                }
            }
        }

        insert("before", function (elem, dom) elem.parentNode.insertBefore(dom, elem));
        insert("after", function (elem, dom) elem.parentNode.insertBefore(dom, elem.nextSibling));
        insert("append", function (elem, dom) elem.appendChild(dom));
        insert("prepend", function (elem, dom) elem.insertBefore(dom, elem.firstChild));
        if (obj.init)
            obj.init(window);

        function load(event) {
            obj.load(window, event);
            if (obj.visible)
                if (!event || !overlay.onWindowVisible || window != util.topWindow(window))
                    obj.visible(window);
                else
                    overlay.onWindowVisible.push(function () { obj.visible(window) });
        }

        if (obj.load)
            if (doc.readyState === "complete")
                load();
            else
                doc.addEventListener("load", util.wrapCallback(function onLoad(event) {
                    if (event.originalTarget === event.target) {
                        doc.removeEventListener("load", onLoad.wrapper, true);
                        load(event);
                    }
                }), true);
    },

    /**
     * Overlays an object with the given property overrides. Each
     * property in *overrides* is added to *object*, replacing any
     * original value. Functions in *overrides* are augmented with the
     * new properties *super*, *supercall*, and *superapply*, in the
     * same manner as class methods, so that they man call their
     * overridden counterparts.
     *
     * @param {object} object The object to overlay.
     * @param {object} overrides An object containing properties to
     *      override.
     * @returns {function} A function which, when called, will remove
     *      the overlay.
     */
    overlayObject: function (object, overrides) {
        let original = Object.create(object);
        overrides = update(Object.create(original), overrides);

        Object.getOwnPropertyNames(overrides).forEach(function (k) {
            let orig, desc = Object.getOwnPropertyDescriptor(overrides, k);
            if (desc.value instanceof Class.Property)
                desc = desc.value.init(k) || desc.value;

            if (k in object) {
                for (let obj = object; obj && !orig; obj = Object.getPrototypeOf(obj))
                    if (orig = Object.getOwnPropertyDescriptor(obj, k))
                        Object.defineProperty(original, k, orig);

                if (!orig)
                    if (orig = Object.getPropertyDescriptor(object, k))
                        Object.defineProperty(original, k, orig);
            }

            // Guard against horrible add-ons that use eval-based monkey
            // patching.
            let value = desc.value;
            if (callable(desc.value)) {

                delete desc.value;
                delete desc.writable;
                desc.get = function get() value;
                desc.set = function set(val) {
                    if (!callable(val) || Function.prototype.toString(val).indexOf(sentinel) < 0)
                        Class.replaceProperty(this, k, val);
                    else {
                        let package_ = util.newURI(util.fixURI(Components.stack.caller.filename)).host;
                        util.reportError(Error(_("error.monkeyPatchOverlay", package_)));
                        util.dactyl.echoerr(_("error.monkeyPatchOverlay", package_));
                    }
                };
            }

            try {
                Object.defineProperty(object, k, desc);

                if (callable(value)) {
                    var sentinel = "(function DactylOverlay() {}())"
                    value.toString = function toString() toString.toString.call(this).replace(/\}?$/, sentinel + "; $&");
                    value.toSource = function toSource() toSource.toSource.call(this).replace(/\}?$/, sentinel + "; $&");
                }
            }
            catch (e) {
                try {
                    if (value) {
                        object[k] = value;
                        return;
                    }
                }
                catch (f) {}
                util.reportError(e);
            }
        }, this);

        return function unwrap() {
            for each (let k in Object.getOwnPropertyNames(original))
                if (Object.getOwnPropertyDescriptor(object, k).configurable)
                    Object.defineProperty(object, k, Object.getOwnPropertyDescriptor(original, k));
                else {
                    try {
                        object[k] = original[k];
                    }
                    catch (e) {}
                }
        };
    },


    /**
     * The most recently active dactyl window.
     */
    get activeWindow() this.windows[0],

    set activeWindow(win) this.windows = [win].concat(this.windows.filter(function (w) w != win)),

    /**
     * A list of extant dactyl windows.
     */
    windows: Class.Memoize(function () [])
});

endModule();

} catch(e){ if (!e.stack) e = Error(e); dump(e.fileName+":"+e.lineNumber+": "+e+"\n" + e.stack); }

// vim: set fdm=marker sw=4 ts=4 et ft=javascript:
