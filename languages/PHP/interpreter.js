/*
 * Uniter - JavaScript PHP interpreter
 * Copyright 2013 Dan Phillimore (asmblah)
 * http://asmblah.github.com/uniter/
 *
 * Released under the MIT license
 * https://github.com/asmblah/uniter/raw/master/MIT-LICENSE.txt
 */

/*
 * PHP Interpreter
 */

/*global define */
define([
    './interpreter/builtin/builtins',
    'js/util',
    'js/Exception',
    './interpreter/KeyValuePair',
    './interpreter/List',
    './interpreter/Environment',
    './interpreter/Error',
    './interpreter/State',
    './interpreter/Scope',
    './interpreter/ScopeChain'
], function (
    builtinTypes,
    util,
    Exception,
    KeyValuePair,
    List,
    PHPEnvironment,
    PHPError,
    PHPState,
    Scope,
    ScopeChain
) {
    'use strict';

    var binaryOperatorToMethod = {
            '+': 'add',
            '-': 'subtract',
            '*': 'multiply',
            '/': 'divide',
            '.': 'concat',
            '<<': 'shiftLeftBy',
            '>>': 'shiftRightBy',
            '==': 'isEqualTo',
            '!=': 'isNotEqualTo',
            '===': 'isIdenticalTo',
            '!==': 'isNotIdenticalTo',
            '=': {
                'false': 'setValue',
                'true': 'setReference'
            }
        },
        unaryOperatorToMethod = {
            prefix: {
                '+': 'toPositive',
                '-': 'toNegative',
                '++': 'preIncrement',
                '--': 'preDecrement',
                '~': 'onesComplement'
            },
            suffix: {
                '++': 'postIncrement',
                '--': 'postDecrement'
            }
        };

    function evaluateModule(state, code, context, stdin, stdout, stderr) {
        var namespace,
            namespaceCollection = state.getNamespaceCollection(),
            valueFactory = state.getValueFactory(),
            referenceFactory = state.getReferenceFactory(),
            result,
            scopeChain = new ScopeChain(stderr),
            tools = {
                createInstance: function (classNameValue) {
                    var className = classNameValue.getNative(),
                        object = new (namespace.getClass(className))();

                    return valueFactory.createObject(object, className);
                },
                createKeyValuePair: function (key, value) {
                    return new KeyValuePair(key, value);
                },
                createList: function (elements) {
                    return new List(elements);
                },
                implyArray: function (variable) {
                    if (variable.getValue().getNative() === null) {
                        variable.setValue(tools.valueFactory.createArray([]));
                    }

                    return variable.getValue();
                },
                popScope: function () {
                    scopeChain.pop();
                },
                pushScope: function () {
                    scopeChain.push(new Scope(valueFactory));
                },
                referenceFactory: referenceFactory,
                unescapeString: function (string) {
                    return string.replace(/\\n/g, '\n');
                },
                valueFactory: valueFactory
            };

        namespace = namespaceCollection.get('\\');

        scopeChain.push(state.getGlobalScope());

        (function () {
            var internals = {
                    stdout: stdout,
                    valueFactory: valueFactory
                };

            util.each(builtinTypes.functionGroups, function (groupFactory) {
                var groupBuiltins = groupFactory(internals);

                util.each(groupBuiltins, function (fn, name) {
                    namespace.defineFunction(name, fn);
                });
            });

            util.each(builtinTypes.classes, function (classFactory, name) {
                var Class = classFactory(internals);

                namespace.defineClass(name, Class);
            });
        }());

        if (getKeys(context.localVariableNames).length > 0) {
            code = 'scopeChain.getCurrent().defineVariables(["' + getKeys(context.localVariableNames).join('", "') + '"]);' + code;
        }

        // Program returns null rather than undefined if nothing is returned
        code += 'return tools.valueFactory.createNull();';

        try {
            /*jshint evil:true */
            result = new Function('stdin, stdout, stderr, tools, scopeChain, namespace', code)(
                stdin, stdout, stderr, tools, scopeChain, namespace
            );
        } catch (exception) {
            if (exception instanceof PHPError) {
                stderr.write(exception.message);
            }

            throw exception;
        }

        return {
            type: result.getType(),
            value: result.getNative()
        };
    }

    function getKeys(object) {
        var keys = [];

        util.each(object, function (value, key) {
            keys.push(key);
        });

        return keys;
    }

    function hoistDeclarations(statements) {
        var declarations = [],
            nonDeclarations = [];

        util.each(statements, function (statement) {
            if (/^N_(CLASS|FUNCTION)_STATEMENT$/.test(statement.name)) {
                declarations.push(statement);
            } else {
                nonDeclarations.push(statement);
            }
        });

        return declarations.concat(nonDeclarations);
    }

    return {
        Environment: PHPEnvironment,
        State: PHPState,
        nodes: {
            'N_ARRAY_INDEX': function (node, interpret, context) {
                var arrayVariableCode,
                    indexValues = [],
                    suffix = '';

                util.each(node.indices, function (index) {
                    indexValues.push(interpret(index.index, {assignment: false, getValue: false}));
                });

                if (context.assignment) {
                    arrayVariableCode = 'tools.implyArray(' + interpret(node.array, {getValue: false}) + ')';
                } else {
                    suffix = '.getValue(scopeChain)';
                    arrayVariableCode = interpret(node.array, {getValue: true});
                }

                return arrayVariableCode + '.getElementByKey(' + indexValues.join(', scopeChain).getValue(scopeChain).getElementByKey(') + ', scopeChain)' + suffix;
            },
            'N_ARRAY_LITERAL': function (node, interpret) {
                var elementValues = [];

                util.each(node.elements, function (element) {
                    elementValues.push(interpret(element));
                });

                return 'tools.valueFactory.createArray([' + elementValues.join(', ') + '])';
            },
            'N_BOOLEAN': function (node) {
                return 'tools.valueFactory.createBoolean(' + node.bool + ')';
            },
            'N_CLASS_STATEMENT': function (node, interpret) {
                var code,
                    methodCodes = [],
                    propertyCodes = [];

                util.each(node.members, function (member) {
                    var data = interpret(member);

                    if (member.name === 'N_PROPERTY_DEFINITION') {
                        propertyCodes.push('"' + data.name + '": ' + data.value);
                    } else if (member.name === 'N_METHOD_DEFINITION') {
                        methodCodes.push('"' + data.name + '": function () {' + data.body + '}');
                    }
                });

                code = '{properties: {' + propertyCodes.join(', ') + '}, methods: {' + methodCodes.join(', ') + '}}';

                return 'namespace.defineClass(' + interpret(node.className) + '.getNative(), ' + code + ');';
            },
            'N_ECHO_STATEMENT': function (node, interpret) {
                return 'stdout.write(' + interpret(node.expression) + '.coerceToString().getNative());';
            },
            'N_EXPRESSION': function (node, interpret) {
                var isAssignment = node.right[0].operator === '=',
                    expression = interpret(node.left, {assignment: isAssignment, getValue: !isAssignment});

                util.each(node.right, function (operation) {
                    var isReference = false,
                        method,
                        valuePostProcess = '';

                    if (isAssignment && operation.operand.reference) {
                        isReference = true;
                        valuePostProcess = '.getReference()';
                    }

                    method = binaryOperatorToMethod[operation.operator];

                    if (util.isPlainObject(method)) {
                        method = method[isReference];
                    }

                    expression += '.' + method + '(' + interpret(operation.operand, {getValue: !isReference}) + valuePostProcess + ')';
                });

                return expression;
            },
            'N_EXPRESSION_STATEMENT': function (node, interpret) {
                return interpret(node.expression) + ';';
            },
            'N_FLOAT': function (node) {
                return 'tools.valueFactory.createFloat(' + node.number + ')';
            },
            'N_FOREACH_STATEMENT': function (node, interpret, context) {
                var arrayValue = interpret(node.array),
                    arrayVariable,
                    code = '',
                    key = node.key ? interpret(node.key, {getValue: false}) : null,
                    lengthVariable,
                    pointerVariable,
                    value = interpret(node.value, {getValue: false});

                if (!context.foreach) {
                    context.foreach = {
                        depth: 0
                    };
                } else {
                    context.foreach.depth++;
                }

                // Ensure the iterator key (if specified) and value variables are defined
                if (key) {
                    context.localVariableNames[node.key.variable] = true;
                }

                context.localVariableNames[node.value.variable] = true;

                arrayVariable = 'array_' + context.foreach.depth;

                // Cache the value being iterated over and reset the internal array pointer before the loop
                code += 'var ' + arrayVariable + ' = ' + arrayValue + '.reset();';

                lengthVariable = 'length_' + context.foreach.depth;
                code += 'var ' + lengthVariable + ' = ' + arrayVariable + '.getLength();';
                pointerVariable = 'pointer_' + context.foreach.depth;
                code += 'var ' + pointerVariable + ' = 0;';

                // Loop management
                code += 'while (' + pointerVariable + ' < ' + lengthVariable + ') {';

                if (key) {
                    // Iterator key variable (if specified)
                    code += key + '.setValue(' + arrayVariable + '.getKeyByIndex(' + pointerVariable + '));';
                }

                // Iterator value variable
                code += value + '.set' + (node.value.reference ? 'Reference' : 'Value') + '(' + arrayVariable + '.getElementByIndex(' + pointerVariable + ')' + (node.value.reference ? '' : '.getValue(scopeChain)') + ');';

                // Set pointer to next element at start of loop body as per spec
                code += pointerVariable + '++;';

                util.each(hoistDeclarations(node.statements), function (statement) {
                    code += interpret(statement);
                });

                code += '}';

                return code;
            },
            'N_FUNCTION_STATEMENT': function (node, interpret) {
                var args = [],
                    argumentAssignments = '',
                    body = '',
                    func,
                    localVariableNames = {},
                    variableDeclarations = '';

                util.each(node.args, function (arg) {
                    args.push(arg.variable);

                    // Define any arguments as local variables
                    localVariableNames[arg.variable] = true;
                });

                // Interpret statements first (will populate localVariableNames)
                util.each(hoistDeclarations(node.statements), function (statement) {
                    body += interpret(statement, {localVariableNames: localVariableNames});
                });

                // Define local variables and arguments
                if (getKeys(localVariableNames).length > 0) {
                    variableDeclarations += 'scopeChain.getCurrent().defineVariables(["' + getKeys(localVariableNames).join('", "') + '"]);';
                }

                // Copy passed values for any arguments
                util.each(args, function (arg) {
                    argumentAssignments += 'scopeChain.getCurrent().getVariable("' + arg + '", scopeChain).setValue(' + arg + ');';
                });

                // Prepend parts in correct order
                body = variableDeclarations + argumentAssignments + body;

                // Add scope handling logic
                body = 'try { tools.pushScope(); ' + body + ' } finally { tools.popScope(); }';

                args.unshift('scopeChain');

                // Build function expression
                func = 'function (' + args.join(', ') + ') {' + body + '}';

                return 'namespace.defineFunction(' + JSON.stringify(node.func) + ', ' + func + ');';
            },
            'N_FUNCTION_CALL': function (node, interpret) {
                var args = ['scopeChain'];

                util.each(node.args, function (arg) {
                    args.push(interpret(arg));
                });

                return 'namespace.getFunction(' + interpret(node.func, {getValue: true}) + '.getNative())(' + args.join(', ') + ')';
            },
            'N_IF_STATEMENT': function (node, interpret) {
                var alternateCode = '',
                    consequentCode = '';

                // Consequent statements are executed if the condition is truthy
                util.each(hoistDeclarations(node.consequentStatements), function (statement) {
                    consequentCode += interpret(statement);
                });

                // Alternate statements are executed if the condition is falsy
                util.each(hoistDeclarations(node.alternateStatements), function (statement) {
                    alternateCode += interpret(statement);
                });

                return 'if (' + interpret(node.condition) + '.coerceToBoolean().getNative()) {' + consequentCode + '} else {' + alternateCode + '}';
            },
            'N_INLINE_HTML_STATEMENT': function (node) {
                return 'stdout.write(' + JSON.stringify(node.html) + ');';
            },
            'N_INTEGER': function (node) {
                return 'tools.valueFactory.createInteger(' + node.number + ')';
            },
            'N_KEY_VALUE_PAIR': function (node, interpret) {
                return 'tools.createKeyValuePair(' + interpret(node.key) + ', ' + interpret(node.value) + ')';
            },
            'N_LIST': function (node, interpret) {
                var elementsCodes = [];

                util.each(node.elements, function (element) {
                    elementsCodes.push(interpret(element, {getValue: false}));
                });

                return 'tools.createList([' + elementsCodes.join(',') + '])';
            },
            'N_METHOD_CALL': function (node, interpret) {
                var code = '';

                util.each(node.calls, function (call) {
                    code += '.callMethod(' + interpret(call.func) + ', [], scopeChain)';
                });

                return interpret(node.object) + code;
            },
            'N_METHOD_DEFINITION': function (node, interpret) {
                var body = '';

                util.each(hoistDeclarations(node.statements), function (statement) {
                    body += interpret(statement);
                });

                return {
                    name: interpret(node.func),
                    body: body
                };
            },
            'N_NEW_EXPRESSION': function (node, interpret) {
                return 'tools.createInstance(' + interpret(node.className) + ')';
            },
            'N_OBJECT_PROPERTY': function (node, interpret, context) {
                var objectVariableCode,
                    propertyCode = '',
                    suffix = '';

                if (context.assignment) {
                    objectVariableCode = 'tools.implyArray(' + interpret(node.object, {getValue: false}) + ')';
                } else {
                    suffix = '.getValue(scopeChain)';
                    objectVariableCode = interpret(node.object, {getValue: true});
                }

                util.each(node.properties, function (property, index) {
                    var keyValue = interpret(property.property, {assignment: false, getValue: false});

                    propertyCode += '.getElementByKey(' + keyValue + ', scopeChain)';

                    if (index < node.properties.length - 1) {
                        propertyCode += '.getValue(scopeChain)';
                    }
                });

                return objectVariableCode + propertyCode + suffix;
            },
            'N_PROGRAM': function (node, interpret, state, stdin, stdout, stderr) {
                var body = '',
                    context = {
                        localVariableNames: {}
                    };

                util.each(hoistDeclarations(node.statements), function (statement) {
                    body += interpret(statement, context);
                });

                return evaluateModule(state, body, context, stdin, stdout, stderr);
            },
            'N_PROPERTY_DEFINITION': function (node, interpret) {
                return {
                    name: node.variable.variable.substr(1),
                    value: node.value ? interpret(node.value) : 'null'
                };
            },
            'N_RETURN_STATEMENT': function (node, interpret) {
                var expression = interpret(node.expression);

                return 'return' + (expression ? ' ' + expression : '') + ';';
            },
            'N_STRING': function (node) {
                switch (node.string) {
                case 'null':
                    return 'tools.valueFactory.createNull()';
                default:
                    return 'tools.valueFactory.createString(' + JSON.stringify(node.string) + ')';
                }
            },
            'N_STRING_LITERAL': function (node) {
                return 'tools.valueFactory.createString(tools.unescapeString(' + JSON.stringify(node.string) + '))';
            },
            'N_TERNARY': function (node, interpret) {
                var expression = '(' + interpret(node.condition) + ')';

                util.each(node.options, function (option) {
                    expression = '(' + expression + '.coerceToBoolean().getNative() ? ' + interpret(option.consequent) + ' : ' + interpret(option.alternate) + ')';
                });

                return expression;
            },
            'N_UNARY_EXPRESSION': function (node, interpret) {
                var operator = node.operator,
                    operand = interpret(node.operand, {getValue: operator !== '++' && operator !== '--'});

                return operand + '.' + unaryOperatorToMethod[node.prefix ? 'prefix' : 'suffix'][operator] + '()';
            },
            'N_VARIABLE': function (node, interpret, context) {
                // Track any implicit variable declarations
                if (context.assignment) {
                    context.localVariableNames[node.variable] = true;
                }

                return 'scopeChain.getCurrent().getVariable("' + node.variable + '", scopeChain)' + (context.getValue !== false ? '.getValue()' : '');
            },
            'N_VOID': function () {
                return 'tools.referenceFactory.createNull()';
            }
        }
    };
});
