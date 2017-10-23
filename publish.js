'use strict'

const doop = require('jsdoc/util/doop')
const env = require('jsdoc/env')
const fs = require('jsdoc/fs')
const helper = require('jsdoc/util/templateHelper')
const logger = require('jsdoc/util/logger')
const path = require('jsdoc/path')
const taffy = require('taffydb').taffy
const template = require('jsdoc/template')
const tutorial = require('jsdoc/tutorial')
const util = require('util')
// for parsing html to dom.
const cheerio = require('cheerio')
const _ = require('underscore')

const htmlsafe = helper.htmlsafe
const resolveAuthorLinks = helper.resolveAuthorLinks
const hasOwnProp = Object.prototype.hasOwnProperty
const linkto = function(item, name, c,d,e) {
    name = name || item.name;
    if(name) name = name.replace(/(^")|("$)/g,'');
    return helper.linkto(item, name, c,d,e);
}


let data
let view
let tutorialsName

let outdir = path.normalize(env.opts.destination)



env.conf.templates = _.extend({useCollapsibles: true}, env.conf.templates)
env.conf.templates.tabNames = _.extend({api: 'API', tutorials: 'Examples'}, env.conf.templates.tabNames)

tutorialsName = env.conf.templates.tabNames.tutorials

// Set default useCollapsibles true
env.conf.templates.useCollapsibles = env.conf.templates.useCollapsibles !== false


function find(spec) {
    return helper.find(data, spec)
}


function tutoriallink(_tutorial) {
    return helper.toTutorial(_tutorial, null, {tag: 'em', classname: 'disabled', prefix: 'Tutorial: '})
}


function getAncestorLinks(doclet) {
    return helper.getAncestorLinks(data, doclet)
}


function hashToLink(doclet, hash) {
    if ( !/^(#.+)/.test(hash) ) {
        return hash
    }

    let url = helper.createLink(doclet)

    url = url.replace(/(#.+|$)/, hash)
    return `<a href="${url}">${hash}</a>`
}


function needsSignature(doclet) {
    let needsSig = false


    // function and class definitions always get a signature
    if (doclet.kind === 'function' || doclet.kind === 'class') {
        needsSig = !doclet.hideconstructor;
    } else if (doclet.kind === 'typedef' && doclet.type && doclet.type.names && doclet.type.names.length) {
        // typedefs that contain functions get a signature, too
        for (let i = 0, l = doclet.type.names.length; i < l; i++) {
            if (doclet.type.names[i].toLowerCase() === 'function') {
                needsSig = true
                break
            }
        }
    }

    return needsSig
}


function getSignatureAttributes(item) {
    let attributes = []

    if (item.optional) {
        attributes.push('opt')
    }

    if (item.nullable === true) {
        attributes.push('nullable')
    } else if (item.nullable === false) {
        attributes.push('non-null')
    }

    return attributes
}


function updateItemName(item) {
    let attributes = getSignatureAttributes(item)
    let itemName = item.name || ''

    if (item.variable) {
        itemName = '&hellip;' + itemName
    }

    if (attributes && attributes.length) {
        itemName = util.format('%s<span class="signature-attributes">%s</span>', itemName, attributes.join(', '))
    }

    return itemName
}


function addParamAttributes(params) {
    return params.filter(function(param) {
        return param.name && param.name.indexOf('.') === -1
    }).map(updateItemName)
}


function buildItemTypeStrings(item) {
    let types = []

    if (item && item.type && item.type.names) {
        item.type.names.forEach(function(name) {
            types.push(linkto(name, htmlsafe(name)))
        })
    }

    return types
}


function buildAttribsString(attribs) {
    let attribsString = ''

    if (attribs && attribs.length) {
        attribsString = util.format('<span class="icon green">%s</span> ', attribs.join('</span>, <span class="icon green">'))
    }

    return attribsString
}


function addNonParamAttributes(items) {
    let types = []

    items.forEach(function(item) {
        types = types.concat(buildItemTypeStrings(item))
    })

    return types
}


function addSignatureParams(f) {
    let params = f.params ? addParamAttributes(f.params) : []

    f.signature = util.format('%s(%s)', (f.signature || ''), params.join(', '))
}


function addSignatureReturns(f) {
    let attribs = []
    let attribsString = ''
    let returnTypes = []
    let returnTypesString = ''

    // Jam all the return-type attributes into an array. This could create odd results (for example,
    // if there are both nullable and non-nullable return types), but let's assume that most people
    // who use multiple @return tags aren't using Closure Compiler type annotations, and vice-versa.
    if (f.returns) {
        f.returns.forEach(function(item) {
            helper.getAttribs(item).forEach(function(attrib) {
                if (attribs.indexOf(attrib) === -1) {
                    attribs.push(attrib)
                }
            })
        })

        attribsString = buildAttribsString(attribs)
    }

    if (f.returns) {
        returnTypes = addNonParamAttributes(f.returns)
    }
    if (returnTypes.length) {
        returnTypesString = util.format(' &rarr; %s{%s}', attribsString, returnTypes.join('|'))
    }

    f.signature = `<span class="signature">${(f.signature || '')}</span>
                   <span class="type-signature">${returnTypesString}</span>`
}


function addSignatureTypes(f) {
    let types = f.type ? buildItemTypeStrings(f) : []

    f.signature = `${(f.signature || '')}<span class="type-signature">${(types.length ? ' :' + types.join('|') : '')}</span>`
}


function addAttribs(f) {
    let attribs = helper.getAttribs(f)
    let attribsString = buildAttribsString(attribs)
    f.attribs = util.format('<span class="type-signature">%s</span>', attribsString)
}


function shortenPaths(files, commonPrefix) {
    Object.keys(files).forEach(function(file) {
        files[file].shortened = files[file].resolved.replace(commonPrefix, '')
            // Always use forward slashes.
            .replace(/\\/g, '/')
    })

    return files
}


function getPathFromDoclet(doclet) {
    if (!doclet.meta) {
        return null
    }

    return doclet.meta.path && doclet.meta.path !== 'null' ? path.join(doclet.meta.path, doclet.meta.filename) : doclet.meta.filename
}


function generate(title, docs, filename, resolveLinks) {
    resolveLinks = resolveLinks === false ? false : true

    let docData = {
        env: env,
        isTutorial: false,
        title: title,
        docs: docs,
        package: find({kind: 'package'})[0],
    }

    let outpath = path.join(outdir, filename)
    let html = view.render('container.tmpl', docData)

    if (resolveLinks) {
        // Turn {@link foo} into <a href="foodoc.html">foo</a>.
        html = helper.resolveLinks(html)
    }

    fs.writeFileSync(outpath, html, 'utf8')
}


function generateSourceFiles(sourceFiles, encoding) {
    encoding = encoding || 'utf8'
    Object.keys(sourceFiles).forEach(function(file) {
        let source
        // Links are keyed to the shortened path in each doclet's `meta.shortpath` property.
        let sourceOutfile = helper.getUniqueFilename(sourceFiles[file].shortened)
        helper.registerLink(sourceFiles[file].shortened, sourceOutfile)

        try {
            source = {
                kind: 'source',
                code: helper.htmlsafe(fs.readFileSync(sourceFiles[file].resolved, encoding)),
            }
        } catch (e) {
            logger.error('Error while generating source file %s: %s', file, e.message)
        }

        generate(`Source: ${sourceFiles[file].shortened}`, [source], sourceOutfile, false)
    })
}

/**
 * Look for classes or functions with the same name as modules (which indicates that the module
 * exports only that class or function), then attach the classes or functions to the `module`
 * property of the appropriate module doclets. The name of each class or function is also updated
 * for display purposes. This function mutates the original arrays.
 *
 * @private
 * @param {Array.<module:jsdoc/doclet.Doclet>} doclets - The array of classes and functions to
 * check.
 * @param {Array.<module:jsdoc/doclet.Doclet>} modules - The array of module doclets to search.
 */
function attachModuleSymbols(doclets, modules) {
    let symbols = {}

    // Build a lookup table.
    doclets.forEach(function(symbol) {
        symbols[symbol.longname] = symbols[symbol.longname] || []
        symbols[symbol.longname].push(symbol)
    })

    return modules.map(function(module) {
        if (symbols[module.longname]) {
            module.modules = symbols[module.longname]
                // Only show symbols that have a description. Make an exception for classes, because
                // we want to show the constructor-signature heading no matter what.
                .filter(function(symbol) {
                    return symbol.description || symbol.kind === 'class'
                })
                .map(function(symbol) {
                    symbol = doop(symbol)

                    if (symbol.kind === 'class' || symbol.kind === 'function') {
                        symbol.name = symbol.name.replace('module:', '(require("') + '"))'
                    }

                    return symbol
                })
        }
    })
}


function buildSubNavMembers(list, type) {
    let html = ''

    if (list.length) {
        html += `<div class="member-type">${type}</div>`
        html += '<ul class="inner">'
        list.forEach(function(item) {
            html += `<li class="sub-nav-item">${linkto(item.longname, item.name, null, null, true)}`
            html += '</a></li>'
        })
        html += '</ul>'
    }

    return html
}


/**
 * The sub navigation item listing.
 * -- 'Classes'
 * -- 'Namespaces'
 * @param obj
 */
function buildSubNav(obj) {
    let longname = obj.longname
    let members = find({
        kind: 'member',
        memberof: longname,
    })
    let methods = find({
        kind: 'function',
        memberof: longname,
    })

    let events = find({
        kind: 'event',
        memberof: longname,
    })
    let typedef = find({
        kind: 'typedef',
        memberof: longname,
    })
    let classes = find({
        kind: 'class',
        memberof: longname,
    })

    let html = `<div class="nav-item-sub hidden" id="${obj.longname.replace(/[^a-zA-Z0-9]/g, '_')}_sub">`

    html += buildSubNavMembers(members, 'Members')
    html += buildSubNavMembers(methods, 'Methods')
    html += buildSubNavMembers(events, 'Events')
    html += buildSubNavMembers(typedef, 'Typedef')
    html += buildSubNavMembers(classes, 'Classes')
    html += '</div>'

    return html
}


function makeCollapsibleItemHtmlInNav(item, linkHtml, hide) {
    return `<li class="nav-item${hide?' hidden':''}">
                <span class="toggle-subnav invisible btn btn-link fa fa-plus"></span>
                ${linkHtml}
                ${buildSubNav(item)}
            </li>`
}


function makeItemHtmlInNav(item, linkHtml, hide) {
    return `<li class="${hide?' hidden':''}">${linkHtml}${buildSubNav(item)}</li>`
}


function buildMemberNav(items, itemHeading, itemsSeen, linktoFn) {
    let nav = ''

    if (items.length) {
        let itemsNav = ''
        let className = itemHeading === tutorialsName ? 'nav-manuals hidden' : 'nav-api hidden'
        let makeHtml = env.conf.templates.useCollapsibles ? makeCollapsibleItemHtmlInNav : makeItemHtmlInNav

        items.forEach(function(item) {
            let linkHtml;

            if ( !hasOwnProp.call(item, 'longname') ) {

                itemsNav += `<li>${linktoFn('', item.name)}${buildSubNav(item)}</li>`
            } else if ( !hasOwnProp.call(itemsSeen, item.longname) ) {
                let displayName
                if (env.conf.templates.default.useLongnameInNav || item.kind === 'namespace') {
                    displayName = item.longname
                } else {
                    displayName = item.name
                }
                linkHtml = linktoFn(item.longname, displayName.replace(/\b(module|event):/g, ''))
                itemsNav += makeHtml(item, linkHtml, !!item.memberof)
            }
        })

        if (itemsNav !== '') {
            nav += `<div class="${className}"><h3>${itemHeading}</h3><ul class="nav-items">${itemsNav}</ul></div>`
        }
    }

    return nav
}


function linktoTutorial(longName, name) {
    return tutoriallink(name)
}

function linktoExternal(longName, name) {
    return linkto(longName, name.replace(/(^"|"$)/g, ''))
}

/**
 * Create the navigation sidebar.
 * @param {object} members The members that will be used to create the sidebar.
 * @param {array<object>} members.classes
 * @param {array<object>} members.externals
 * @param {array<object>} members.globals
 * @param {array<object>} members.mixins
 * @param {array<object>} members.modules
 * @param {array<object>} members.namespaces
 * @param {array<object>} members.tutorials
 * @param {array<object>} members.events
 * @param {array<object>} members.interfaces
 * @return {string} The HTML for the navigation sidebar.
 */
function buildNav(members) {
    let nav = ''
    let seen = {}
    let seenTutorials = {}

    nav += buildMemberNav(members.tutorials, tutorialsName, seenTutorials, linktoTutorial, true)
    nav += buildMemberNav(members.modules, 'Modules', {}, linkto)
    nav += buildMemberNav(members.externals, 'Externals', seen, linktoExternal)
    nav += buildMemberNav(members.namespaces, 'Namespaces', seen, linkto)
    nav += buildMemberNav(members.classes, 'Classes', seen, linkto)
    nav += buildMemberNav(members.mixins, 'Mixins', seen, linkto)
    nav += buildMemberNav(members.interfaces, 'Interfaces', seen, linkto)

    if (members.globals.length) {
        let globalNav = ''
        let useGlobalTitleLink = true

        members.globals.forEach(function(g) {
            if (!hasOwnProp.call(seen, g.longname)) {
                //  - Add global-typedef in hidden to search api.
                //  - Default template did not add this.
                if (g.kind === 'typedef') {
                    globalNav += `<li class="nav-item hidden">${linkto(g.longname, g.name)}</li>`
                } else {
                    globalNav += `<li class="nav-item">${linkto(g.longname, g.name)}</li>`
                    useGlobalTitleLink = false
                }
            }

            seen[g.longname] = true
        })

        if (useGlobalTitleLink) {
            // turn the heading into a link so you can actually get to the global page
            nav = `<div class="nav-api hidden"><h3>${linkto('global', 'Global')}</h3></div>` + nav
        } else {
            nav = `<div class="nav-api hidden"><h3>Global</h3><ul>${globalNav}</ul></div>` + nav
        }
    }

    return nav
}


/**
 * Look ma, it's cp -R.
 * @param {string} src The path to the thing to copy.
 * @param {string} dest The path to the new copy.
 */
let copyRecursiveSync = function(src, dest) {
    let contents
    let destExists = fs.existsSync(dest)
    let srcExists = fs.existsSync(src)
    let stats = srcExists && fs.statSync(src)
    let isDirectory = srcExists && stats.isDirectory()

    if (srcExists) {
        if (isDirectory) {
            if (!destExists) {
                fs.mkdirSync(dest)
            }
            fs.readdirSync(src).forEach(function(childItemName) {
                copyRecursiveSync(path.join(src, childItemName),
                    path.join(dest, childItemName))
            })
        } else {
            contents = fs.readFileSync(src)
            fs.writeFileSync(dest, contents)
        }
    }
}

/**
 * @param {TAFFY} taffyData See <http://taffydb.com/>.
 * @param {object} opts
 * @param {Tutorial} tutorials
 */
exports.publish = function(taffyData, opts, tutorials) {
    data = taffyData

    let conf = env.conf.templates || {}
    conf.default = conf.default || {}

    let templatePath = path.normalize(opts.template)
    view = new template.Template(path.join(templatePath, 'tmpl'))

    // Claim some special filenames in advance, so the All-Powerful Overseer of
    // Filename Uniqueness doesn't try to hand them out later.
    let indexUrl = helper.getUniqueFilename('index')
    // Don't call registerLink() on this one! 'index' is also a valid longname.

    let globalUrl = helper.getUniqueFilename('global')
    helper.registerLink('global', globalUrl)

    // Set up templating.
    view.layout = conf.default.layoutFile ? path.getResourcePath(path.dirname(conf.default.layoutFile), path.basename(conf.default.layoutFile)) : 'layout.tmpl'
    // Set up tutorials for helper.
    helper.setTutorials(tutorials)

    data = helper.prune(data)
    //data.sort('longname, version, since')
    helper.addEventListeners(data)

    let sourceFiles = {}
    let sourceFilePaths = []
    data().each(function(doclet) {
        doclet.attribs = ''

        if (doclet.examples) {
            doclet.examples = doclet.examples.map(function(example) {
                let caption
                let code

                if (example.match(/^\s*<caption>([\s\S]+?)<\/caption>(\s*[\n\r])([\s\S]+)$/i)) {
                    caption = RegExp.$1
                    code = RegExp.$3
                }

                return {
                    caption: caption || '',
                    code: code || example,
                }
            })
        }
        if (doclet.see) {
            doclet.see.forEach(function(seeItem, i) {
                doclet.see[i] = hashToLink(doclet, seeItem)
            })
        }

        // Build a list of source files.
        let sourcePath
        if (doclet.meta) {
            sourcePath = getPathFromDoclet(doclet)
            sourceFiles[sourcePath] = {
                resolved: sourcePath,
                shortened: null,
            }
            if (sourceFilePaths.indexOf(sourcePath) === -1) {
                sourceFilePaths.push(sourcePath)
            }
        }
    })

    fs.mkPath(outdir)

    // Copy the template's static files to outdir.
    copyRecursiveSync(path.join(templatePath, 'static'), outdir);

    // Copy user-specified static files to outdir.
    let staticFilePaths
    let staticFileFilter
    let staticFileScanner
    if (conf.default.staticFiles) {
        // The canonical property name is `include`. We accept `paths` for backwards compatibility
        // with a bug in JSDoc 3.2.x.
        staticFilePaths = conf.default.staticFiles.include || conf.default.staticFiles.paths || []
        staticFileFilter = new (require('jsdoc/src/filter')).Filter(conf.default.staticFiles)
        staticFileScanner = new (require('jsdoc/src/scanner')).Scanner()

        staticFilePaths.forEach(function(filePath) {
            let extraStaticFiles

            filePath = path.resolve(env.pwd, filePath)
            extraStaticFiles = staticFileScanner.scan([filePath], 10, staticFileFilter)

            extraStaticFiles.forEach(function(fileName) {
                let sourcePath = fs.toDir(filePath)
                let toDir = fs.toDir(fileName.replace(sourcePath, outdir))
                fs.mkPath(toDir)
                fs.copyFileSync(fileName, toDir)
            })
        })
    }

    if (sourceFilePaths.length) {
        sourceFiles = shortenPaths(sourceFiles, path.commonPrefix(sourceFilePaths))
    }
    data().each(function(doclet) {
        let url = helper.createLink(doclet)
        helper.registerLink(doclet.longname, url)

        // Add a shortened version of the full path.
        let docletPath
        if (doclet.meta) {
            docletPath = getPathFromDoclet(doclet)
            docletPath = sourceFiles[docletPath].shortened
            if (docletPath) {
                doclet.meta.shortpath = docletPath
            }
        }
    })

    data().each(function(doclet) {
        let url = helper.longnameToUrl[doclet.longname]

        if (url.indexOf('#') > -1) {
            doclet.id = helper.longnameToUrl[doclet.longname].split(/#/).pop()
        } else {
            doclet.id = doclet.name
        }

        if (needsSignature(doclet)) {
            addSignatureParams(doclet)
            addSignatureReturns(doclet)
            addAttribs(doclet)
        }
    })

    // Do this after the urls have all been generated.
    data().each(function(doclet) {
        doclet.ancestors = getAncestorLinks(doclet)

        if (doclet.kind === 'member') {
            addSignatureTypes(doclet)
            addAttribs(doclet)
        }

        if (doclet.kind === 'constant') {
            addSignatureTypes(doclet)
            addAttribs(doclet)
            doclet.kind = 'member'
        }
    })

    let members = helper.getMembers(data)

    members.tutorials = tutorials.children

    // Output pretty-printed source files by default.
    let outputSourceFiles = conf.default && conf.default.outputSourceFiles !== false ? true : false

    // Add template helpers.
    view.find = find
    view.linkto = linkto
    view.resolveAuthorLinks = resolveAuthorLinks
    view.tutoriallink = tutoriallink
    view.htmlsafe = htmlsafe
    view.outputSourceFiles = outputSourceFiles

    // Once for all.
    view.nav = buildNav(members)

    attachModuleSymbols( find({ longname: {left: 'module:'} }), members.modules )

    // Generate the pretty-printed source files first so other pages can link to them.
    if (outputSourceFiles) {
        generateSourceFiles(sourceFiles, opts.encoding)
    }

    if (members.globals.length) {
        generate('Global', [{kind: 'globalobj'}], globalUrl)
    }

    // Index page displays information from package.json.
    let packages = find({kind: 'package'})

    generate('Home', packages.concat([{
        kind: 'mainpage',
        readme: opts.readme,
        longname: (opts.mainpagetitle) ? opts.mainpagetitle : 'Main Page',
    }]), indexUrl)

    // Set up the lists that we'll use to generate pages.
    let classes = taffy(members.classes)
    let modules = taffy(members.modules)
    let namespaces = taffy(members.namespaces)
    let mixins = taffy(members.mixins)
    let externals = taffy(members.externals)
    let interfaces = taffy(members.interfaces)

    Object.keys(helper.longnameToUrl).forEach(function(longname) {
        let myModules = helper.find(modules, {longname: longname})
        if (myModules.length) {
            generate(`Module: ${myModules[0].name}`, myModules, helper.longnameToUrl[longname])
        }

        let myClasses = helper.find(classes, {longname: longname})
        if (myClasses.length) {
            generate(`Class: ${myClasses[0].name}`, myClasses, helper.longnameToUrl[longname])
        }

        let myNamespaces = helper.find(namespaces, {longname: longname})
        if (myNamespaces.length) {
            generate(`Namespace: ${myNamespaces[0].name}`, myNamespaces, helper.longnameToUrl[longname])
        }

        let myMixins = helper.find(mixins, {longname: longname})
        if (myMixins.length) {
            generate(`Mixin: ${myMixins[0].name}`, myMixins, helper.longnameToUrl[longname])
        }

        let myExternals = helper.find(externals, {longname: longname})
        if (myExternals.length) {
            generate(`External: ${myExternals[0].name}`, myExternals, helper.longnameToUrl[longname])
        }

        let myInterfaces = helper.find(interfaces, {longname: longname})
        if (myInterfaces.length) {
            generate(`Interface: ${myInterfaces[0].name}`, myInterfaces, helper.longnameToUrl[longname])
        }
    })

    if (env.opts.tutorials) {
        copyRecursiveSync(env.opts.tutorials, `${outdir}/tutorials`)
    }


    function generateHtmlTutorialData(_tutorial, filename, originalFileName) {
        let $ = cheerio.load(_tutorial.parse(), {
            decodeEntities: false,
            normalizeWhitespace: false,
        })

        return {
            codeHtml: htmlsafe($('div.code-html').html() || ''),
            codeJs: htmlsafe($('script.code-js').html() || ''),
            originalFileName: originalFileName,
        }
    }


    function generateTutorial(title, _tutorial, fileName, originalFileName, isHtmlTutorial) {
        let tutorialData = {
            // Errors in layout.tmpl if docs property does not exist. (For left-nav member listing control)
            docs: null,
            isTutorial: true,
            env: env,
            title: title,
            header: _tutorial.title,
            children: _tutorial.children,
            isHtmlTutorial: isHtmlTutorial,
            package: find({kind: 'package'})[0],
        }

        if (isHtmlTutorial) {
            _.extend(tutorialData, generateHtmlTutorialData(_tutorial, fileName, originalFileName))
        } else {
            tutorialData.content = _tutorial.parse()
        }

        let tutorialPath = path.join(outdir, fileName)
        let html = view.render('tutorial.tmpl', tutorialData)

        // Yes, you can use {@link} in tutorials too!
        // Turn {@link foo} into <a href="foodoc.html">foo</a>.
        html = helper.resolveLinks(html)
        fs.writeFileSync(tutorialPath, html, 'utf8')
    }


    /**
     * Tutorials can have only one parent so there is no risk for loops.
     */
    function saveChildren(node) {
        node.children.forEach(function(child) {
            let originalFileName = child.name
            let isHtmlTutorial = child.type === tutorial.TYPES.HTML
            let title = `Tutorial: ${child.title}`
            let fileName = helper.tutorialToUrl(child.name)

            generateTutorial(title, child, fileName, originalFileName, isHtmlTutorial)
            saveChildren(child)
        })
    }
    saveChildren(tutorials)
}
