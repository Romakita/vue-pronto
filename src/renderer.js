// @flow
const fs = require("fs");
const path = require("path");
const requireFromString = require("require-from-string");
const vueCompiler = require("vue-template-compiler");
const vueify = require("vueify");
const vueServerRenderer = require("vue-server-renderer");
const Vue = require("vue");
const butternut = require("butternut");
const uglify = require("uglify-js");
const LRU = require("lru-cache");
const processStyle = require("./process-style").processStyle;


class Renderer {
    cacheOptions: {
        max: number,
        maxAge: number
    };
    lruCache: LRU;
    template: string;
    renderer: vueServerRenderer;
    constructor(options: Object = {}) {
        if (options.cacheOptions) {
            this.cacheOptions = options.cacheOptions;
        } else {
            this.cacheOptions = {
                max: 500,
                maxAge: 1000 * 60 * 60
            };
        }

        if (options.template) {
            this.template = options.template;
        } else {
            this.template = `<!DOCTYPE html>
            <html lang="en">
                <head>
                    <title>{{title}}</title>
                    <style>{{css}}</style>
                </head>
                <body>
                    <!--vue-ssr-outlet-->
                </body>
            </html>`;
        }

        this.lruCache = LRU(this.cacheOptions);
    }
    FixData(oldData: Object, newData: Object) {
        const mergedData = Object.assign({}, oldData, newData);
        return function() {
            return mergedData;
        };
    }
    BuildComponent(componentFile: string, filePath: string, vueComponentMatch: string): Promise<{compiled: string, filePath: string, match: string}> {
        return new Promise((resolve, reject) => {
            const relativePath = path.resolve(path.parse(filePath).dir, componentFile);
            this.Compile(relativePath)
                .then(compiled => {
                    
                    this.FindAndReplaceComponents(compiled.compiled, filePath)
                        .then((codeString) => {
                            const renderFunctionRegex = /(?:__vue__options__.render=function\(\){)(.*)(?:};?,?__)/gm;
                            const staticRenderFunctionsRegex = /(?:__vue__options__.staticRenderFns=\[)(.*)(?:\])/gm;
                            const exportsRegex = /(?:module.exports={)(.*)(?:}}\(\);?)/gm;
                            const importsRegex = /(?:"use strict";?)(.*)(?:module.exports={)/gm;
        
                            let imports = "";
                            let moduleExports = "";
                            let renderFunctionContents = "";
                            let staticRenderFns = "";

                            // const {code, map} = butternut.squash(compiled.compiled);
                            const {code} = uglify.minify(codeString, {mangle:false});
                            // const code = compiled.compiled.replace(/(\r\n\t\s{2,}|\n|\r|\t|\s{2,})/gm,"");
                            // let code = compiled.compiled;
                            const importMatches = importsRegex.exec(code);
                            if (importMatches && importMatches.length > 0) {
                                imports = importMatches[1];
                            }

                            const exportMatches = exportsRegex.exec(code);
                            if (exportMatches && exportMatches.length > 0) {
                                moduleExports = exportMatches[1];
                            }
                            const renderFunctionMatches = renderFunctionRegex.exec(code);
                            if (renderFunctionMatches && renderFunctionMatches.length > 0) {
                                renderFunctionContents = `,render: function render() {${renderFunctionMatches[1]}}`;
                            }
                            const staticRenderMatches = staticRenderFunctionsRegex.exec(code);
                            if (staticRenderMatches && staticRenderMatches.length > 0) {
                                staticRenderFns = `,staticRenderFns: [${staticRenderMatches[1]}]`;
                            }
                            let vueComponent = "";
                            if (imports === "") {
                                vueComponent = `{${moduleExports}${renderFunctionContents}${staticRenderFns}}`;
                            } else {
                                vueComponent = `function () {${imports}return {${moduleExports}${renderFunctionContents}${staticRenderFns}}}()`;
                            }
                            
                            resolve({
                                compiled: vueComponent,
                                filePath: filePath,
                                match: vueComponentMatch
                            });
                        }).catch(error => {
                            reject(error);
                        });
                })
                .catch(reject);
        });
    }
    FindAndReplaceComponents(code: string, filePath: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const vueFileRegex = /([\w/.\-@_\d]*\.vue)/igm;
            const requireRegex = /(require\(['"])([\w:/.\-@_\d]*\.vue)(['"]\))/igm;
            let vueComponentMatches = code.match(requireRegex);
            if (vueComponentMatches && vueComponentMatches.length > 0) {
                let promiseArray = [];
                for (let index = 0; index < vueComponentMatches.length; index++) {
                    const vueComponentMatch = vueComponentMatches[index];
                    const vueComponentFile = vueComponentMatch.match(vueFileRegex);
                    if (vueComponentFile && vueComponentFile.length > 0) {
                        promiseArray.push(this.BuildComponent(vueComponentFile[0], filePath, vueComponentMatch));
                    }
                }
                Promise.all(promiseArray).then(renderedItemArray => {
                    for (var index = 0; index < renderedItemArray.length; index++) {
                        var renderedItem = renderedItemArray[index];
                        code = code.replace(renderedItem.match, renderedItem.compiled);
                    }
                    //check if its the last element and then render
                    const last_element = code.match(vueFileRegex);
                    if (last_element === undefined || last_element === null) {
                        resolve(code);
                    }
                }).catch(reject);
            } else {
                resolve(code);
            }
        });
    }
    Compile(filePath: string): Promise<{compiled: string, style: string}> {
        return new Promise((resolve, reject) => {
            fs.readFile(filePath, function(err, fileContent) {
                if (err) {
                    reject(err);
                }
                const content = String(fileContent);
                let resolvedParts = {
                    styles: []
                };
                let compiled = {
                    compiled: "",
                    style: ""
                };

                const stylesArray = vueCompiler.parseComponent(content, {pad: true}).styles;
                const compiler = vueify.compiler;
                compiler.compile(content, filePath, function(error, stringFile) {
                    if (error) {
                        reject(error);
                    }
                    if (stylesArray.length > 0) {
                        processStyle(stylesArray[0], filePath, "", resolvedParts)
                            .then(() => {
                                compiled.compiled = stringFile;
                                compiled.style = resolvedParts.styles.join("\n");

                                resolve(compiled);
                            })
                            .catch(reject);
                    } else {
                        compiled.compiled = stringFile;
                        resolve(compiled);
                    }
                });
            });
        });
    }
    MakeBundle(stringFile: string, filePath: string): Promise<Object> {
        return new Promise((resolve, reject) => {
            this.FindAndReplaceComponents(stringFile, filePath)
                .then(code => {
                    const bundle = requireFromString(code);
                    resolve(bundle);
                })
                .catch(reject);
        });
    }
    MakeVueClass(filePath: string, data: Object): Promise<{vue: Vue, css: string}> {
        return new Promise((resolve, reject) => {
            const cachedBundle = this.lruCache.get(filePath);
            if (cachedBundle) {
                cachedBundle.bundle.data = this.FixData(cachedBundle.bundle.data(), data);
                const vue = new Vue(cachedBundle.bundle);
                const object = {
                    vue:vue,
                    css: cachedBundle.style
                };
                resolve(object);
            } else {
                //Make Bundle
                this.Compile(filePath)
                    .then(compiled => {
                        this.MakeBundle(compiled.compiled, filePath)
                            .then(bundle =>{
                                this.lruCache.set(filePath, {bundle: bundle, style: compiled.style});
                                //Insert Data
                                bundle.data = this.FixData(bundle.data(), data);
                                //Create Vue Class
                                const vue = new Vue(bundle);
                                const object = {
                                    vue: vue,
                                    css: compiled.style
                                };
                                resolve(object);
                            })
                            .catch(reject);
                    })
                    .catch(reject);
            }
        });
    }
    RenderToString(vuefile: string, data: Object, vueOptions: Object): Promise<Object> {
        return new Promise((resolve, reject) => {
            this.renderer = vueServerRenderer.createRenderer({
                cache: this.lruCache,
                template: vueOptions.template ? vueOptions.template : this.template
            });
            this.MakeVueClass(vuefile, data)
                .then(vueClass => {
                    //Init Renderer
                    const context = {
                        title: vueOptions.title,
                        css: vueClass.css
                    };
                    this.renderer.renderToString(vueClass.vue, context)
                        .then(html => {
                            resolve(html);
                        })
                        .catch(reject);
                })
                .catch(reject);
        });
    }
    /**
     * renderToStream is the main function used by res.renderVue
     * @param  {string} vuefile    - full path to .vue component
     * @param  {Object} data       - data to be inserted when generating vue class
     * @param  {Object} vueOptions - vue options to be used when generating head
     * @return {Promise}           - Promise returns a Stream
     */
    RenderToStream(vuefile: string, data: Object, vueOptions: Object): Promise<Object> {
        return new Promise((resolve, reject) => {
            this.renderer = vueServerRenderer.createRenderer({
                cache: this.lruCache,
                template: vueOptions.template ? vueOptions.template : this.template
            });
            this.MakeVueClass(vuefile, data)
                .then(vueClass => {
                    //Init Renderer
                    const context = {
                        title: vueOptions.title ? vueOptions.title : "",
                        css: vueClass.css
                    };
                    const vueStream = this.renderer.renderToStream(vueClass.vue, context);
                    resolve(vueStream);
                })
                .catch(reject);
        });
    }
}

module.exports = Renderer;
