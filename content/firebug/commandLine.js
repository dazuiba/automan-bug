/* See license.txt for terms of usage */

FBL.ns(function() { with (FBL) {

// ************************************************************************************************
// Constants

const Cc = Components.classes;
const Ci = Components.interfaces;

const commandHistoryMax = 1000;
const commandPrefix = ">>>";

const reOpenBracket = /[\[\(\{]/;
const reCloseBracket = /[\]\)\}]/;
const reCmdSource = /^with\(_FirebugCommandLine\){(.*)};$/;

// ************************************************************************************************
// Globals

var commandHistory = [""];
var commandPointer = 0;
var commandInsertPointer = -1;

// ************************************************************************************************

Firebug.CommandLine = extend(Firebug.Module,
{
    dispatchName: "commandLine",

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

    // targetWindow was needed by evaluateInSandbox, let's leave it for a while in case
    // we rethink this yet again

    initializeCommandLineIfNeeded: function (context, win)
    {
        if (!context || !win)
            return;

      // The command-line requires that the console has been initialized first,
      // so make sure that's so.  This call should have no effect if the console
      // is already initialized.
      var consoleIsReady = Firebug.Console.isReadyElsePreparing(context, win);

      // Make sure the command-line is initialized.  This call should have no
      // effect if the command-line is already initialized.
      var commandLineIsReady = Firebug.CommandLine.isReadyElsePreparing(context, win);

      if (FBTrace.DBG_COMMANDLINE)
          FBTrace.sysout("commandLine.initializeCommandLineIfNeeded console ready: " +
            consoleIsReady + " commandLine ready: " + commandLineIsReady);
    },

    // returns user-level wrapped object I guess.
    evaluate: function(expr, context, thisValue, targetWindow, successConsoleFunction, exceptionFunction)
    {
        if (!context)
            return;

        try
        {
            var result = null;
            var debuggerState = Firebug.Debugger.beginInternalOperation();

            if (this.isSandbox(context))
                result = this.evaluateInSandbox(expr, context, thisValue, targetWindow, successConsoleFunction, exceptionFunction);
            else if (context.stopped)
                result = this.evaluateInDebugFrame(expr, context, thisValue, targetWindow,  successConsoleFunction, exceptionFunction);
            else
                result = this.evaluateByEventPassing(expr, context, thisValue, targetWindow, successConsoleFunction, exceptionFunction);

            context.invalidatePanels('dom', 'html');
        }
        catch (exc)  // XXX jjb, I don't expect this to be taken, the try here is for the finally
        {
            if (FBTrace.DBG_ERRORS || FBTrace.DBG_COMMANDLINE)
                FBTrace.sysout("commandLine.evaluate with context.stopped:" + context.stopped +
                    " EXCEPTION " + exc, exc);
        }
        finally
        {
            Firebug.Debugger.endInternalOperation(debuggerState);
        }

        return result;
    },

    evaluateByEventPassing: function(expr, context, thisValue, targetWindow, successConsoleFunction, exceptionFunction)
    {
        var win = targetWindow ? targetWindow : (context.baseWindow ? context.baseWindow : context.window);

        if (!win)
        {
            if (FBTrace.DBG_ERRORS || FBTrace.DBG_COMMANDLINE)
                FBTrace.sysout("commandLine.evaluateByEventPassing: no targetWindow!\n");
            return;
        }

        // We're going to use some command-line facilities, but it may not have initialized yet.
        this.initializeCommandLineIfNeeded(context, win);

        // Make sure the command line script is attached.
        var attached = win.document.getUserData("firebug-CommandLineAttached");
        if (!attached)
        {
            FBTrace.sysout("commandLine: document does not have command line attached " +
                "its too early for command line", document);

            Firebug.Console.logFormatted(["Firebug cannot find firebug-CommandLineAttached " +
                "document.getUserData , its too early for command line",
                 win], context, "error", true);
            return;
        }

        var event = document.createEvent("Events");
        event.initEvent("firebugCommandLine", true, false);
        win.document.setUserData("firebug-methodName", "evaluate", null);

        expr = expr.toString();
        expr = "with(_FirebugCommandLine){" + expr + "\n};";
        win.document.setUserData("firebug-expr", expr, null);

        if (!context.activeConsoleHandlers)
        {
            if (FBTrace.DBG_ERRORS || FBTrace.DBG_COMMANDLINE)
                FBTrace.sysout("commandLine.evaluateByEventPassing no consoleHandler ",
                    context.activeConsoleHandlers);
            return;
        }

        var consoleHandler = context.activeConsoleHandlers[win.wrappedJSObject];

        if (!consoleHandler)
        {
            FBTrace.sysout("commandLine evaluateByEventPassing no consoleHandler ",
                context.activeConsoleHandlers);
            return;
        }

        if (successConsoleFunction)
        {
            consoleHandler.setEvaluatedCallback( function useConsoleFunction(result)
            {
                successConsoleFunction(result, context);  // result will be pass thru this function
            });
        }

        if (exceptionFunction)
        {
            consoleHandler.setEvaluateErrorCallback(function useExceptionFunction(result)
            {
                exceptionFunction(result, context);
            });
        }
        else
        {
            consoleHandler.setEvaluateErrorCallback(function useErrorFunction(result)
            {
                if (result)
                {
                    var m = reCmdSource.exec(result.source);
                    if (m && m.length > 0)
                        result.source = m[1];
                }

                Firebug.Console.logFormatted([result], context, "error", true);
            });
        }

        if (FBTrace.DBG_COMMANDLINE)
            FBTrace.sysout("commandLine.evaluateByEventPassing \'"+expr+"\' using consoleHandler:", consoleHandler);

        win.document.dispatchEvent(event);

        if (FBTrace.DBG_COMMANDLINE)
            FBTrace.sysout("commandLine.evaluateByEventPassing return after firebugCommandLine event:", event);
    },

    evaluateInDebugFrame: function(expr, context, thisValue, targetWindow,  successConsoleFunction, exceptionFunction)
    {
        var result = null;

        // targetWindow may be frame in HTML
        var win = targetWindow ? targetWindow : (context.baseWindow ? context.baseWindow : context.window);

        if (!context.commandLineAPI)
            context.commandLineAPI = new FirebugCommandLineAPI(context, (win.wrappedJSObject?win.wrappedJSObject:win));  // TODO should be baseWindow

        var htmlPanel = context.getPanel("html", true);
        var scope = {
            api       : context.commandLineAPI,
            vars      : htmlPanel?htmlPanel.getInspectorVars():null,
            thisValue : thisValue
        };

        try
        {
            result = Firebug.Debugger.evaluate(expr, context, scope);
            successConsoleFunction(result, context);  // result will be pass thru this function
        }
        catch (e)
        {
            exceptionFunction(e, context);
        }
        return result;
    },

    evaluateByPostMessage: function(expr, context, thisValue, targetWindow, successConsoleFunction, exceptionFunction)
    {
        // targetWindow may be frame in HTML
        var win = targetWindow ? targetWindow : (context.baseWindow ? context.baseWindow : context.window);
        if (!win)
        {
            if (FBTrace.DBG_ERRORS || FBTrace.DBG_COMMANDLINE)
                FBTrace.sysout("commandLine.evaluateByPostMessage: no targetWindow!\n");
            return;
        }

        // We're going to use some command-line facilities, but it may not have initialized yet.
        this.initializeCommandLineIfNeeded(context, win);

        expr = expr.toString();
        expr = "with(_FirebugCommandLine){" + expr + "\n};";

        var consoleHandler = context.activeConsoleHandlers[win.wrappedJSObject];

        if (!consoleHandler)
        {
            FBTrace.sysout("commandLine evaluateByPostMessage no consoleHandler ",
                context.activeConsoleHandlers);
            return;
        }

        if (successConsoleFunction)
        {
            consoleHandler.setEvaluatedCallback( function useConsoleFunction(result)
            {
                successConsoleFunction(result, context);  // result will be pass thru this function
            });
        }

        if (exceptionFunction)
        {
            consoleHandler.evaluateError = function useExceptionFunction(result)
            {
                exceptionFunction(result, context);
            }
        }
        else
        {
            consoleHandler.evaluateError = function useErrorFunction(result)
            {
                if (result)
                {
                    var m = reCmdSource.exec(result.source);
                    if (m && m.length > 0)
                        result.source = m[1];
                }

                Firebug.Console.logFormatted([result], context, "error", true);
            }
        }

        return win.postMessage(expr, "*");
    },

    evaluateInWebPage: function(expr, context, targetWindow)
    {
        var win = targetWindow ? targetWindow : context.window;
        var doc = (win.wrappedJSObject ? win.wrappedJSObject.document : win.document);
        var element = addScript(doc, "_firebugInWebPage", expr);
        element.parentNode.removeChild(element);  // we don't need the script element, result is in DOM object
        return "true";
    },

    // isSandbox(context) true, => context.global is a Sandbox
    evaluateInSandbox: function(expr, context, thisValue, targetWindow, successConsoleFunction, exceptionFunction)
    {
        var scriptToEval = expr;

        try
        {
            result = Components.utils.evalInSandbox(scriptToEval, context.global);
            if (FBTrace.DBG_COMMANDLINE)
                FBTrace.sysout("commandLine.evaluateInSandbox success for sandbox ", scriptToEval);
            successConsoleFunction(result, context);  // result will be pass thru this function
        }
        catch (e)
        {
            if (FBTrace.DBG_ERRORS || FBTrace.DBG_COMMANDLINE)
                FBTrace.sysout("commandLine.evaluateInSandbox FAILED in "+context.getName()+
                    " because "+e, e);

            exceptionFunction(e, context);

            result = new FBL.ErrorMessage("commandLine.evaluateInSandbox FAILED: " + e,
                FBL.getDataURLForContent(scriptToEval, "FirebugCommandLineEvaluate"),
                e.lineNumber, 0, "js", context, null);
        }
        return result;
    },

    isSandbox: function (context)
    {
        return (context.global && context.global+"" === "[object Sandbox]");
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

    enter: function(context, command)
    {
        var commandLine = getCommandLine(context);
        var expr = command ? command : commandLine.value;
        if (expr == "")
            return;

        var mozJSEnabled = Firebug.getPref("javascript", "enabled");
        if (mozJSEnabled)
        {
            if (!Firebug.largeCommandLine)
            {
                this.clear(context);
                this.appendToHistory(expr);
                Firebug.Console.log(commandPrefix + " " + expr, context, "command", FirebugReps.Text);
            }
            else
            {
                var shortExpr = cropString(stripNewLines(expr), 100);
                Firebug.Console.log(commandPrefix + " " + shortExpr, context, "command", FirebugReps.Text);
            }

            var noscript = getNoScript();
            if (noscript)
            {
                var noScriptURI = noscript.getSite(Firebug.chrome.getCurrentURI().spec);
                if (noScriptURI)
                    noScriptURI = (noscript.jsEnabled || noscript.isJSEnabled(noScriptURI)) ? null : noScriptURI;
            }

            if (noscript && noScriptURI)
                noscript.setJSEnabled(noScriptURI, true);

            var goodOrBad = FBL.bind(Firebug.Console.log, Firebug.Console);
            this.evaluate(expr, context, null, null, goodOrBad, goodOrBad);

            if (noscript && noScriptURI)
                noscript.setJSEnabled(noScriptURI, false);
        }
        else
        {
            Firebug.Console.log($STR("console.JSDisabledInFirefoxPrefs"), context, "info");
        }
    },

    enterMenu: function(context)
    {
        var commandLine = getCommandLine(context);
        var expr = commandLine.value;
        if (expr == "")
            return;

        this.appendToHistory(expr, true);

        this.evaluate(expr, context, null, null, function(result, context)
        {
            if (typeof(result) != "undefined")
            {
                Firebug.chrome.contextMenuObject = result;

                var popup = Firebug.chrome.$("fbContextMenu");
                popup.showPopup(commandLine, -1, -1, "popup", "bottomleft", "topleft");
            }
        });
    },

    enterInspect: function(context)
    {
        var commandLine = getCommandLine(context);
        var expr = commandLine.value;
        if (expr == "")
            return;

        this.clear(context);
        this.appendToHistory(expr);

        this.evaluate(expr, context, null, null, function(result, context)
        {
            if (typeof(result) != undefined)
                Firebug.chrome.select(result);
        });
    },

    reenter: function(context)
    {
        var command = commandHistory[commandInsertPointer];
        if (command)
            this.enter(context, command);
    },

    copyBookmarklet: function(context)
    {
        var commandLine = getCommandLine(context);
        var expr = "javascript: " + stripNewLines(commandLine.value);
        copyToClipboard(expr);
    },

    focus: function(context)
    {
        if (Firebug.isDetached())
            Firebug.chrome.focus();
        else
            Firebug.toggleBar(true);

        var commandLine = getCommandLine(context);

        if (!context.panelName)
        {
            Firebug.chrome.selectPanel("console");
        }
        else if (context.panelName != "console")
        {
            Firebug.chrome.switchToPanel(context, "console");
            setTimeout(function() { commandLine.select(); });
        }
        else
        {
            // We are already on the console, if the command line has also
            // the focus, toggle back.
            if (commandLine.getAttribute("focused") == "true")
                Firebug.chrome.unswitchToPanel(context, "console", true);
            else
                setTimeout(function() { commandLine.select(); });
        }
    },

    clear: function(context)
    {
        var commandLine = getCommandLine(context);
        commandLine.value = context.commandLineText = "";
        this.autoCompleter.reset();
    },

    cancel: function(context)
    {
        var commandLine = getCommandLine(context);
        if (!this.autoCompleter.revert(commandLine))
            this.clear(context);
    },

    update: function(context)
    {
        var commandLine = getCommandLine(context);
        context.commandLineText = commandLine.value;
        this.autoCompleter.reset();
    },

    complete: function(context, reverse)
    {
        var commandLine = getCommandLine(context);
        this.autoCompleter.complete(context, commandLine, true, reverse);
        context.commandLineText = commandLine.value;
    },

    setMultiLine: function(multiLine, chrome, saveMultiLine)
    {
        if (FirebugContext && FirebugContext.panelName != "console")
            return;

        collapse(chrome.$("fbCommandBox"), multiLine);
        collapse(chrome.$("fbPanelSplitter"), !multiLine);
        collapse(chrome.$("fbSidePanelDeck"), !multiLine);

        if (multiLine)
            chrome.$("fbSidePanelDeck").selectedPanel = chrome.$("fbLargeCommandBox");

        var commandLineSmall = chrome.$("fbCommandLine");
        var commandLineLarge = chrome.$("fbLargeCommandLine");

        if (saveMultiLine)  // we are just closing the view
        {
            commandLineSmall.value = commandLineLarge.value;
            return;
        }

        if (multiLine)
            commandLineLarge.value = cleanIndentation(commandLineSmall.value);
        else
            commandLineSmall.value = stripNewLines(commandLineLarge.value);
    },

    toggleMultiLine: function(forceLarge)
    {
        var large = forceLarge || !Firebug.largeCommandLine;
        if (large != Firebug.largeCommandLine)
            Firebug.setPref(Firebug.prefDomain, "largeCommandLine", large);
    },

    checkOverflow: function(context)
    {
        if (!context)
            return;

        var commandLine = getCommandLine(context);
        if (commandLine.value.indexOf("\n") >= 0)
        {
            setTimeout(bindFixed(function()
            {
                Firebug.setPref(Firebug.prefDomain, "largeCommandLine", true);
            }, this));
        }
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

    appendToHistory: function(command, unique)
    {
        if (unique && commandHistory[commandInsertPointer] == command)
            return;

        ++commandInsertPointer;
        if (commandInsertPointer >= commandHistoryMax)
            commandInsertPointer = 0;

        commandPointer = commandInsertPointer+1;
        commandHistory[commandInsertPointer] = command;
    },

    cycleCommandHistory: function(context, dir)
    {
        var commandLine = getCommandLine(context);

        commandHistory[commandPointer] = commandLine.value;

        if (dir < 0)
        {
            --commandPointer;
            if (commandPointer < 0)
                commandPointer = 0;
        }
        else
        {
            ++commandPointer;
            if (commandPointer > commandInsertPointer+1)
                commandPointer = commandInsertPointer+1;
        }

        var command = commandHistory[commandPointer];

        this.autoCompleter.reset();

        commandLine.value = context.commandLineText = command;
        commandLine.inputField.setSelectionRange(command.length, command.length);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // extends Module

    initialize: function()
    {
        Firebug.Module.initialize.apply(this, arguments);

        this.autoCompleter = new Firebug.AutoCompleter(getExpressionOffset, getDot,
            autoCompleteEval, false, true);

        if (Firebug.largeCommandLine)
            this.setMultiLine(true, Firebug.chrome);
    },

    initializeUI: function()
    {
        this.attachListeners();
    },

    reattachContext: function(browser, context)
    {
        this.attachListeners();
    },

    attachListeners: function()
    {
        Firebug.chrome.$("fbLargeCommandLine").addEventListener('focus', this.onCommandLineFocus, true);
        Firebug.chrome.$("fbCommandLine").addEventListener('focus', this.onCommandLineFocus, true);

        Firebug.Console.addListener(this);  // to get onConsoleInjection
    },

    showContext: function(browser, context)
    {
        var command = Firebug.chrome.$("cmd_focusCommandLine");
        command.setAttribute("disabled", !context);
    },

    destroyContext: function(context, persistedState)
    {
         // our work is done in the Console
    },

    showPanel: function(browser, panel)
    {
        var chrome = Firebug.chrome;

        var isConsole = panel && panel.name == "console";
        if (Firebug.largeCommandLine)
        {
            if (isConsole)
            {
                collapse(chrome.$("fbPanelSplitter"), false);
                collapse(chrome.$("fbSidePanelDeck"), false);
                chrome.$("fbSidePanelDeck").selectedPanel = chrome.$("fbLargeCommandBox");
                collapse(chrome.$("fbCommandBox"), true);
            }
        }
        else
            collapse(chrome.$("fbCommandBox"), !isConsole);

        var value = panel ? panel.context.commandLineText : null;
        var commandLine = getCommandLine(browser);
        commandLine.value = value ? value : "";
    },

    updateOption: function(name, value)
    {
        if (name == "largeCommandLine")
            this.setMultiLine(value, Firebug.chrome);
    },

    // called by users of command line, currently:
    // 1) Console on focus command line, 2) Watch onfocus, and 3) debugger loadedContext if watches exist
    isReadyElsePreparing: function(context, win)
    {
        if (FBTrace.DBG_COMMANDLINE)
            FBTrace.sysout("commandLine.isReadyElsePreparing ", context);

        if (this.isSandbox(context))
            return;

        if (win)
            Firebug.CommandLine.injector.attachCommandLine(context, win);
        else
        {
            Firebug.CommandLine.injector.attachCommandLine(context, context.window);
            for (var i = 0; i < context.windows.length; i++)
                Firebug.CommandLine.injector.attachCommandLine(context, context.windows[i]);
        }

        if (!context.window.wrappedJSObject)
        {
            FBTrace.sysout("context.window with no wrappedJSObject!", context.window);
            return false;
        }

        // the attach is asynchronous, we can report when it is complete:
        if (context.window.wrappedJSObject._FirebugCommandLine)
            return true;
        else
            return false;
    },

    onCommandLineFocus: function(event)
    {
        Firebug.CommandLine.attachConsoleOnFocus();

        if (!Firebug.CommandLine.isAttached(FirebugContext))
        {
            return Firebug.CommandLine.isReadyElsePreparing(FirebugContext);
        }
        else
        {
            if (FBTrace.DBG_COMMANDLINE)
            {
                try
                {
                    var cmdLine = FirebugContext.window.wrappedJSObject._FirebugCommandLine
                    FBTrace.sysout("commandLine.onCommandLineFocus, attachCommandLine ", cmdLine);
                }
                catch (e)
                {
                    FBTrace.sysout("commandLine.onCommandLineFocus, did NOT attachCommandLine ", e);
                }
            }
            return true; // is attached.
        }
    },

    isAttached: function(context)
    {
        return context && context.window && context.window.wrappedJSObject &&
            context.window.wrappedJSObject._FirebugCommandLine;
    },

    attachConsoleOnFocus: function()
    {
        if (!FirebugContext)
        {
            if (FBTrace.DBG_ERRORS || FBTrace.DBG_COMMANDLINE)
                FBTrace.sysout("commandLine.attachConsoleOnFocus no FirebugContext");
            return;
        }

        if (FBTrace.DBG_COMMANDLINE)
            FBTrace.sysout("commandLine.attachConsoleOnFocus: FirebugContext is "+FirebugContext.getName() +
                " in window "+window.location);

        // User has decided to use the command line, but the web page may not have the console
        // if the page has no javascript
        if (Firebug.Console.isReadyElsePreparing(FirebugContext))
        {
            // the page had _firebug so we know that consoleInjected.js compiled and ran.
            if (FBTrace.DBG_COMMANDLINE)
            {
                if (FirebugContext)
                    FBTrace.sysout("commandLine.attachConsoleOnFocus: "+FirebugContext.getName());
                else
                    FBTrace.sysout("commandLine.attachConsoleOnFocus: No FirebugContext\n");
            }
        }
        else
        {
            Firebug.Console.injector.forceConsoleCompilationInPage(FirebugContext, FirebugContext.window);

            if (FBTrace.DBG_COMMANDLINE)
                FBTrace.sysout("commandLine.attachConsoleOnFocus, attachConsole "+
                    FirebugContext.window.location);
        }
    },

    onPanelEnable: function(panelName)
    {
        collapse(Firebug.chrome.$("fbCommandBox"), true);
        collapse(Firebug.chrome.$("fbPanelSplitter"), true);
        collapse(Firebug.chrome.$("fbSidePanelDeck"), true);

        this.setMultiLine(Firebug.largeCommandLine, Firebug.chrome);
    },

    onPanelDisable: function(panelName)
    {
        if (panelName != 'console')  // we don't care about other panels
            return;

        collapse(Firebug.chrome.$("fbCommandBox"), true);
        collapse(Firebug.chrome.$("fbPanelSplitter"), true);
        collapse(Firebug.chrome.$("fbSidePanelDeck"), true);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // Firebug.Console listener

    onConsoleInjected: function(context, win)
    {
        // for some reason the console has been injected. If the user had focus in the command
        // line they want it added in the page also. If the user has the cursor in the command
        // line and reloads, the focus will already be there. issue 1339
        var isFocused = ($("fbLargeCommandLine").getAttribute("focused") == "true");
        isFocused = isFocused || ($("fbCommandLine").getAttribute("focused") == "true");
        if (isFocused)
            setTimeout(this.onCommandLineFocus);
    },
});

// ************************************************************************************************
// Shared Helpers

Firebug.CommandLine.CommandHandler = extend(Object,
{
    handle: function(event, api, win)
    {
        var element = event.target;
        var methodName = win.document.getUserData("firebug-methodName");

        var hosed_userObjects = (win.wrappedJSObject?win.wrappedJSObject:win)._firebug.userObjects;

        var userObjects = hosed_userObjects ? cloneArray(hosed_userObjects) : [];

        if (FBTrace.DBG_COMMANDLINE)
        {
            FBTrace.sysout("commandLine.CommandHandler: method "+methodName+" userObjects:",  userObjects);
            FBTrace.sysout("commandLine.CommandHandler: "+(win.wrappedJSObject?"win.wrappedJSObject._firebug":"win._firebug"), (win.wrappedJSObject?win.wrappedJSObject._firebug:win._firebug));
            if (!userObjects)
                debugger;
        }

        var subHandler = api[methodName];
        if (!subHandler)
            return false;

        win.document.setUserData("firebug-retValueType", null, null);
        var result = subHandler.apply(api, userObjects);
        if (typeof result != "undefined")
        {
            if (result instanceof Array)
            {
                win.document.setUserData("firebug-retValueType", "array", null);
                for (var item in result)
                    hosed_userObjects.push(result[item]);
            }
            else
            {
                hosed_userObjects.push(result);
            }
        }

        return true;
    }
});

// ************************************************************************************************
// Local Helpers

function getExpressionOffset(command, offset)
{
    // XXXjoe This is kind of a poor-man's JavaScript parser - trying
    // to find the start of the expression that the cursor is inside.
    // Not 100% fool proof, but hey...

    var bracketCount = 0;

    var start = command.length-1;
    for (; start >= 0; --start)
    {
        var c = command[start];
        if ((c == "," || c == ";" || c == " ") && !bracketCount)
            break;
        if (reOpenBracket.test(c))
        {
            if (bracketCount)
                --bracketCount;
            else
                break;
        }
        else if (reCloseBracket.test(c))
            ++bracketCount;
    }

    return start + 1;
}

function getDot(expr, offset)
{
    var lastDot = expr.lastIndexOf(".");
    if (lastDot == -1)
        return null;
    else
        return {start: lastDot+1, end: expr.length-1};
}

function autoCompleteEval(preExpr, expr, postExpr, context)
{
    try
    {
        if (preExpr)
        {
            // Remove the trailing dot (if there is one)
            var lastDot = preExpr.lastIndexOf(".");
            if (lastDot != -1)
                preExpr = preExpr.substr(0, lastDot);

            var self = this;
            Firebug.CommandLine.evaluate(preExpr, context, context.thisValue, null,
                function found(result, context)
                {
                    if (FBTrace.DBG_COMMANDLINE)
                        FBTrace.sysout("commandLine.autoCompleteEval \'"+preExpr+"\' found result", result);

                    self.complete = keys(result).sort();
                },
                function failed(result, context)
                {
                    if (FBTrace.DBG_COMMANDLINE)
                        FBTrace.sysout("commandLine.autoCompleteEval \'"+preExpr+"\' failed result", result);

                    self.complete = [];
                }
            );
            return self.complete;
        }
        else
        {
            if (context.stopped)
                return Firebug.Debugger.getCurrentFrameKeys(context);

            // Cross window type pseudo-comparison
            var innerWindow = context.window.wrappedJSObject;
            if (innerWindow && innerWindow.Window && innerWindow.constructor.toString() === innerWindow.Window.toString())
                return keys(context.window.wrappedJSObject).sort();  // return is safe
            else  // hopefull sandbox in Chromebug
                return keys(context.global).sort();
        }
    }
    catch (exc)
    {
        if (FBTrace.DBG_ERRORS || FBTrace.DBG_COMMANDLINE)
            FBTrace.sysout("commandLine.autoCompleteEval FAILED", exc);
        return [];
    }
}

function injectScript(script, win)
{
    win.location = "javascript: " + script;
}

// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

function getCommandLine(context)
{
    return Firebug.largeCommandLine
        ? Firebug.chrome.$("fbLargeCommandLine")
        : Firebug.chrome.$("fbCommandLine");
}

const reIndent = /^(\s+)/;

function getIndent(line)
{
    var m = reIndent.exec(line);
    return m ? m[0].length : 0;
}

function cleanIndentation(text)
{
    var lines = splitLines(text);

    var minIndent = -1;
    for (var i = 0; i < lines.length; ++i)
    {
        var line = lines[i];
        var indent = getIndent(line);
        if (minIndent == -1 && line && !isWhitespace(line))
            minIndent = indent;
        if (indent >= minIndent)
            lines[i] = line.substr(minIndent);
    }
    return lines.join("");
}

// ************************************************************************************************
// Command line APIs definition

function FirebugCommandLineAPI(context, baseWindow)
{
    this.$ = function(id)
    {
        var doc = baseWindow.document;
        return baseWindow.document.getElementById(id);
    };

    this.$$ = function(selector)
    {
        return FBL.getElementsBySelector(baseWindow.document, selector);
    };

    this.$x = function(xpath)
    {
        return FBL.getElementsByXPath(baseWindow.document, xpath);
    };

    this.$n = function(index)
    {
        var htmlPanel = context.getPanel("html", true);
        if (!htmlPanel)
            return null;

        if (index < 0 || index >= htmlPanel.inspectorHistory.length)
            return null;

        var node = htmlPanel.inspectorHistory[index];
        if (!node)
            return node;

        return node.wrappedJSObject;
    };

    this.cd = function(object)
    {
        if (!(object instanceof Window))
            throw "Object must be a window.";

        // Make sure the command line is attached into the target iframe.
        var consoleReady = Firebug.Console.isReadyElsePreparing(context, object);
        if (FBTrace.DBG_COMMANDLINE)
            FBTrace.sysout("commandLine.cd; console ready: " + consoleReady);

        // The window object parameter uses XPCSafeJSObjectWrapper, but we need XPCNativeWrapper
        // (and its wrappedJSObject member). So, look within all registered consoleHandlers for
        // the same window (from tabWatcher) that uses uses XPCNativeWrapper (operator "==" works).
        for (var p in context.activeConsoleHandlers) {
            if (context.activeConsoleHandlers.hasOwnProperty(p) && p == object) {
                baseWindow = context.baseWindow = p;
                break;
            }
        }

        Firebug.Console.log(["Current window:", context.baseWindow], context, "info");
    };

    this.clear = function()
    {
        Firebug.Console.clear(context);
    };

    this.inspect = function(obj, panelName)
    {
        Firebug.chrome.select(obj, panelName);
    };

    this.keys = function(o)
    {
        return FBL.keys(o);
    };

    this.values = function(o)
    {
        return FBL.values(o);
    };

    this.debug = function(fn)
    {
        Firebug.Debugger.monitorFunction(fn, "debug");
    };

    this.undebug = function(fn)
    {
        Firebug.Debugger.unmonitorFunction(fn, "debug");
    };

    this.monitor = function(fn)
    {
        Firebug.Debugger.monitorFunction(fn, "monitor");
    };

    this.unmonitor = function(fn)
    {
        Firebug.Debugger.unmonitorFunction(fn, "monitor");
    };

    this.traceAll = function()
    {
        Firebug.Debugger.traceAll(FirebugContext);
    };

    this.untraceAll = function()
    {
        Firebug.Debugger.untraceAll(FirebugContext);
    };

    this.traceCalls = function(fn)
    {
        Firebug.Debugger.traceCalls(FirebugContext, fn);
    };

    this.untraceCalls = function(fn)
    {
        Firebug.Debugger.untraceCalls(FirebugContext, fn);
    };

    this.monitorEvents = function(object, types)
    {
        monitorEvents(object, types, context);
    };

    this.unmonitorEvents = function(object, types)
    {
        unmonitorEvents(object, types, context);
    };

    this.profile = function(title)
    {
        Firebug.Profiler.startProfiling(context, title);
    };

    this.profileEnd = function()
    {
        Firebug.Profiler.stopProfiling(context);
    };

    this.copy = function(x)
    {
        FBL.copyToClipboard(x);
    };
}

// ************************************************************************************************

Firebug.CommandLine.injector = {

    attachCommandLine: function(context, win)
    {
        if (!win)
            return;

        if (win instanceof Window)
        {
            // If the command line is already attached then end.
            if (win.document.getUserData("firebug-CommandLineListener") === "true")
                return;

            var doc = win.document;

            if (context.stopped)
                Firebug.CommandLine.injector.evalCommandLineScript(context);
            else
                Firebug.CommandLine.injector.injectCommandLineScript(doc);

            Firebug.CommandLine.injector.addCommandLineListener(context, win);
        }
        else if (Firebug.CommandLine.isSandbox(context))
        {
            if (FBTrace.DBG_COMMANDLINE)
                FBTrace.sysout("commandLine.injector context.global "+context.global, context.global);
            // no-op
        }
        else
        {
            if (FBTrace.DBG_COMMANDLINE)
                FBTrace.sysout("commandLine.injector not a Window or Sandbox", win);
        }
    },

    evalCommandLineScript: function(context)
    {
        var scriptSource = getResource("chrome://firebug/content/commandLineInjected.js");
        Firebug.Debugger.evaluate(scriptSource, context);
        if (FBTrace.DBG_COMMANDLINE)
            FBTrace.sysout("commandLine.evalCommandLineScript ", scriptSource);
    },

    injectCommandLineScript: function(doc)
    {
        // Inject command line script into the page.
        var scriptSource = getResource("chrome://firebug/content/commandLineInjected.js");
        var addedElement = addScript(doc, "_firebugCommandLineInjector", scriptSource);
        if (FBTrace.DBG_COMMANDLINE)
            FBTrace.sysout("commandLine.injectCommandLineScript ", addedElement);

        // take it right back out, we don't want users to see the things we do ;-)
        addedElement.parentNode.removeChild(addedElement);
    },

    addCommandLineListener: function(context, win)
    {
        if (win.wrappedJSObject)
            win = win.wrappedJSObject;

        // Register listener for command-line execution events.
        var handler = new CommandLineHandler(context, win);

        if (!context.activeCommandLineHandlers)
            context.activeCommandLineHandlers = {};

        var boundHandler = bind(handler.handleEvent, handler);

        context.activeCommandLineHandlers[win] = boundHandler;

        win.document.addEventListener("firebugExecuteCommand", boundHandler, true);
        win.document.setUserData("firebug-CommandLineListener", "true", null);

        if (FBTrace.DBG_COMMANDLINE)
            FBTrace.sysout("commandLine.addCommandLineListener to document in window"+win.location+" with console ", win.console);
    },

    detachCommandLine: function(context, win)
    {
        if (win.wrappedJSObject)
            win = win.wrappedJSObject;

        if (win.document.getUserData("firebug-CommandLineListener") === "true")
        {
            Firebug.CommandLine.evaluate("window._FirebugCommandLine.detachCommandLine()", context);
            if (context.activeCommandLineHandlers)
            {
                var boundHandler = context.activeCommandLineHandlers[win];
                if (boundHandler)
                    win.document.removeEventListener("firebugExecuteCommand", boundHandler, true);
            }

            win.document.setUserData("firebug-CommandLineListener", null, null);
            if (FBTrace.DBG_COMMANDLINE)
                FBTrace.sysout("commandLine.detachCommandLineListener "+boundHandler+" in window with console "+win.location);
        }
    }
};

function CommandLineHandler(context, win)
{
    this.handleEvent = function(event)  // win is the window the handler is bound into
    {
        var baseWindow = context.baseWindow? context.baseWindow : context.window;
        this.api = new FirebugCommandLineAPI(context,  baseWindow.wrappedJSObject);

        if (FBTrace.DBG_COMMANDLINE)
            FBTrace.sysout("commandLine.handleEvent('firebugExecuteCommand') event in baseWindow "+
                baseWindow.location, event);

        // Appends variables into the api.
        var htmlPanel = context.getPanel("html", true);
        var vars = htmlPanel?htmlPanel.getInspectorVars():null;
        for (var prop in vars)
        {
            function createHandler(p) {
                return function() {
                    if (FBTrace.DBG_COMMANDLINE)
                        FBTrace.sysout("commandLine.getInspectorHistory: " + p, vars);
                    return vars[p] ? vars[p].wrappedJSObject : null;
                }
            }
            this.api[prop] = createHandler(prop);  // XXXjjb should these be removed?
        }

        if (!Firebug.CommandLine.CommandHandler.handle(event, this.api, win))
        {
            var methodName = win.document.getUserData("firebug-methodName");
            Firebug.Console.log($STRF("commandline.MethodNotSupported", [methodName]));
        }

        if (FBTrace.DBG_COMMANDLINE)
            FBTrace.sysout("commandLine.handleEvent() "+win.document.getUserData("firebug-methodName")+
                " context.baseWindow: "+(context.baseWindow?context.baseWindow.location:"no basewindow"),
                context.baseWindow);
    };
}

function getNoScript()
{
    if (!this.noscript)
        this.noscript = Cc["@maone.net/noscript-service;1"] &&
            Cc["@maone.net/noscript-service;1"].getService().wrappedJSObject;
    return this.noscript;
}

// ************************************************************************************************
// Registration

Firebug.registerModule(Firebug.CommandLine);

// ************************************************************************************************
}});
