var sf = {
    apiVersion: '41.0',
    proxy: 'https://cors-anywhere.herokuapp.com/',
    connection: {
        isLoggedIn: false,
        instanceUrl: null,
        sessionId: null,
        login: function(username, password, securityToken, onLogin, onError) {
            net.ajax('https://login.salesforce.com/services/Soap/u/42.0', 'POST', '<?xml version="1.0" encoding="utf-8" ?>\n' +
                '<env:Envelope xmlns:xsd="http://www.w3.org/2001/XMLSchema"\n' +
                '    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"\n' +
                '    xmlns:env="http://schemas.xmlsoap.org/soap/envelope/">\n' +
                '  <env:Body>\n' +
                '    <n1:login xmlns:n1="urn:partner.soap.sforce.com">\n' +
                '      <n1:username>' + username + '</n1:username>\n' +
                '      <n1:password>' + password + securityToken + '</n1:password>\n' +
                '    </n1:login>\n' +
                '  </env:Body>\n' +
                '</env:Envelope>', {
                'Content-type': 'text/xml',
                'SOAPAction': '\'\''
            }, function(xhr) {
                if (xhr.status === 200) {
                    sf.connection.isLoggedIn = true;
                    sf.connection.sessionId = helpers.getXMLValue(xhr.responseText, 'sessionId');

                    if (helpers.getXMLValue(xhr.responseText, 'serverUrl').match('https://.*.my.salesforce.com/') === null)
                        sf.connection.instanceUrl = helpers.getXMLValue(xhr.responseText, 'serverUrl').match('https://.*.salesforce.com/')[0];
                    else sf.connection.instanceUrl = helpers.getXMLValue(xhr.responseText, 'serverUrl').match('https://.*.my.salesforce.com/')[0];

                    if (onLogin !== null || onLogin !== undefined)
                        onLogin();
                } else {
                    if (onError !== null || onError !== undefined)
                        onError(helpers.getXMLValue(xhr.responseText, 'faultstring'));
                }
            });
        },
        ajax: function(url, method, data, headers, callback, async) {
            if (!this.isLoggedIn)
                return;

            if (async === null || async === undefined)
                async = true;

            headers['Authorization'] = 'Bearer ' + this.sessionId;
            headers['X-SFDC-Session'] = this.sessionId;

            net.ajax(this.instanceUrl + url, method, data, headers, callback, async);
        }
    },
    bulk: {
        doJob: function(options, onSuccess, onError) {
            if (!sf.connection.isLoggedIn) {
                dom.log.error('You must be logged in');
                return;
            }

            if (options['operation'] === 'delete' && options['object'] === 'User') {
                if (onError !== null && onError !== undefined)
                    onError();
                return;
            }

            sf.connection.ajax('/services/data/v' + sf.apiVersion + '/jobs/ingest', 'POST', JSON.stringify({
                'operation': options['operation'],
                'object': options['object'],
                'contentType': options['contentType'],
                'lineEnding': options['lineEnding']
            }), {
                'Content-type': 'application/json'
            }, function(xhr) {
                if (xhr.status === 200) {
                    var job = JSON.parse(xhr.responseText);

                    sf.connection.ajax('/services/data/v' + sf.apiVersion + '/jobs/ingest/' + job['id'] + '/batches', 'PUT', options['data'], {
                        'Content-type': 'text/csv'
                    }, function(xhr) {
                        if (xhr.status === 201) {
                            sf.connection.ajax('/services/data/v' + sf.apiVersion + '/jobs/ingest/' + job['id'], 'PATCH', JSON.stringify({
                                'state': 'UploadComplete'
                            }), {
                                'Content-type': 'application/json'
                            }, function(xhr) {
                                if (xhr.status === 200) {
                                    if (onSuccess !== null && onSuccess !== undefined)
                                        onSuccess(JSON.parse(xhr.responseText));
                                } else {
                                    if (onError !== null && onError !== undefined)
                                        onError(xhr.responseText);
                                }
                            })
                        } else {
                            if (onError !== null && onError !== undefined)
                                onError(xhr.responseText);
                        }
                    })
                } else {
                    if (onError !== null && onError !== undefined)
                        onError(xhr.responseText);
                }
            })
        }
    },
    soql: {
        query: function(query, callback, async) {
            if (async === null || async === undefined)
                async = true;

            sf.connection.ajax('/services/data/v' + sf.apiVersion + '/query?q=' + query, 'GET', null, {}, function(xhr) {
                if (callback !== null && callback !== undefined)
                    callback(JSON.parse(xhr.responseText));
            }, async);
        }
    },
    utils: {
        recursiveDelete: function(objectApiName) {
            var itemsToDelete = [];

            var searchDeep = function(objectApiName, parentIds, parentField) {
                var query = 'SELECT Id FROM ' + objectApiName;

                // if (parentIds !== null && parentIds !== undefined) {
                //     query += ' WHERE ' + parentField + ' IN (';

                //     helpers.forEach(parentIds, function(item) {
                //         query += '\'' + item + '\',';
                //     });
                //     query = query.substring(0, query.length - 1);

                //     query += ')';
                // }

                sf.soql.query(query, function(result) {
                    if (result.records.length <= 0)
                        return;

                    var records = result.records;

                    if (itemsToDelete[objectApiName] === undefined)
                        itemsToDelete[objectApiName] = [];

                    helpers.forEach(records, function (item) {
                        itemsToDelete[objectApiName].push(item['Id']);
                    });

                    dom.log.info('Deleting ' + records.length + ' record(s) of ' + objectApiName + ' object');

                    sf.connection.ajax('/services/data/v' + sf.apiVersion + '/sobjects/' + objectApiName + '/describe', 'GET', {}, {}, function(xhr) {
                        if (xhr.status === 200) {
                            var result = JSON.parse(xhr.responseText);

                            helpers.forEach(result['childRelationships'], function(item) {
                                if (item['restrictedDelete']) {
                                    var parentIds = [];

                                    helpers.forEach(records, function(item) {
                                        parentIds.push(item['Id']);
                                    });

                                    dom.log.info(objectApiName + ' can be blocking by ' + item['childSObject']);
                                    searchDeep(item['childSObject'], parentIds, item['field']);
                                }
                            });
                        } else {
                            dom.log.error('Unknown error: ' + xhr.responseText);
                        }
                    }, false);
                }, false);
            };

            searchDeep(objectApiName);

            var reversedProps = [];
            for (var propName in itemsToDelete) {
                reversedProps.unshift(propName);
            }

            if (reversedProps.length === 0) {
                dom.log.error('Nothing to delete');
                return;
            }

            var index = 0;
            var createBulk = function() {
                var objectName = reversedProps[index];
                var objectIds = itemsToDelete[objectName];

                var data = '"Id"';
                helpers.forEach(objectIds, function(item) {
                    data += '\r\n"' + item + '"';
                });

                var options = {
                    'operation' : 'delete',
                    'object' : objectName,
                    'contentType' : 'CSV',
                    'lineEnding': 'CRLF',
                    'data' : data
                };

                var onSuccess = function() {
                    index++;
                    if (index < reversedProps.length)
                        createBulk();
                    else {
                        dom.log.success('All delete Bulk jobs are created. Check your Org. If delete operations failed - just rerun script');
                    }
                };

                dom.log.info('Creating delete Bulk job for ' + objectName + ' object');
                if (options['object'] === 'User') {
                    onSuccess();
                } else sf.bulk.doJob(options, onSuccess);
            };
            createBulk();
        }
    }
};

var net = {
    ajax: function(url, method, data, headers, callback, async) {
        var xhr = new XMLHttpRequest();

        if (async === null || async === undefined)
            async = true;

        xhr.open(method, sf.proxy + url, async);
        for (property in headers) {
            xhr.setRequestHeader(property, headers[property]);
        }

        xhr.onreadystatechange = function() {
            if (xhr.readyState === 4) {
                callback(xhr);
            }
        };
        xhr.send(data);
    }
};

var helpers = {
    getXMLValue: function(input, tag) {
        return input.match('<' + tag + '>(.*)</' + tag + '>')[1];
    },
    forEach: function(array, callback) {
        for (property in array) {
            callback(array[property]);
        }
    }
};

var dom = {
    log: {
        showMessage: function (text, logLevel) {
            var template = document.getElementById('log-item-template');
            var container = document.getElementById('log-container');

            var newItem = document.createElement('div');
            newItem.innerHTML = template.innerHTML;
            newItem.classList.add(logLevel);

            newItem.querySelector('.log-item-date').innerHTML = '[' + new Date().getHours() + ':' + new Date().getMinutes() + ':' + new Date().getSeconds() + ']';
            newItem.querySelector('.log-item-level').innerHTML = logLevel + ' | ';
            newItem.querySelector('.log-item-text').innerHTML = text;

            container.appendChild(newItem);

            console.log(text);
        },
        debug: function(text) {
            dom.log.showMessage(text, 'debug');
        },
        info: function(text) {
            dom.log.showMessage(text, 'info');
        },
        error: function(text) {
            dom.log.showMessage(text, 'error');
        },
        success: function(text) {
            dom.log.showMessage(text, 'success');
        }
    }
};

var recordsCreator = {
    createContacts: function(count) {
        if (Number.isNaN(parseInt(count))) {
            dom.log.error('Count is not a number');
            return;
        }

        var maxDuplicateCount = Math.round(count * 0.5);
        count -= maxDuplicateCount;

        var currentDuplicateCount = 0;

        dom.log.info('Getting Name examples');

        var namesPage = Math.round(Math.random() * 12) + 1;
        net.ajax('https://www.behindthename.com/names/usage/english/' + namesPage, 'GET', {}, {}, function(xhr) {
            if (xhr.status === 200) {
                var html = document.createElement('html');
                html.innerHTML = xhr.responseText;

                var names = html.querySelectorAll('.browsename');

                dom.log.info('Getting Surnames examples');

                net.ajax('https://www.houseofnames.com/top-surnames.html', 'GET', {}, {}, function(xhr) {
                    if (xhr.status === 200) {
                        var html = document.createElement('html');
                        html.innerHTML = xhr.responseText;

                        var surnames = html.querySelectorAll('#mainNoScrolls div > a > b');

                        dom.log.info('Generating records...');

                        var csvData = '"LastName","Phone","Email"';

                        var prevDuplicatePack = null;

                        for (var i = 0; i < count; i++) {
                            var csvLine = '\r\n';

                            var firstNameIndex = Math.round(Math.random() * (names.length - 1));
                            var surnameIndex = Math.round(Math.random() * (surnames.length - 1));
                            var phoneNumber = '(' + Math.round(Math.random() * 1000) + ') ' + Math.round(Math.random() * 1000) + '-' + Math.round(Math.random() * 1000) + '';

                            var firstName = names[firstNameIndex].querySelector('b > a').innerHTML.toLowerCase();
                            firstName = firstName[0].toUpperCase() + firstName.substring(1);
                            if (firstName.indexOf(' ') > -1)
                                firstName = firstName.substring(0, firstName.indexOf(' '));
                            var surname = surnames[surnameIndex].innerHTML;
                            surname = surname.substring(0, surname.indexOf(' '));

                            if (Math.round(Math.random()) > 0.5 && currentDuplicateCount < maxDuplicateCount && names[firstNameIndex].parentNode.querySelectorAll('.browsename:nth-child(' + firstNameIndex + ') > a').length > 0) {
                                //Generate duplicates pack
                                if (prevDuplicatePack !== null) {
                                    csvData += prevDuplicatePack;
                                    prevDuplicatePack = null;
                                }

                                var duplicateFirstName = names[firstNameIndex].parentNode.querySelector('.browsename:nth-child(' + firstNameIndex + ') > a').innerHTML.toLowerCase();
                                duplicateFirstName = duplicateFirstName[0].toUpperCase() + duplicateFirstName.substring(1);
                                if (duplicateFirstName.indexOf(' ') > -1)
                                    duplicateFirstName = duplicateFirstName.substring(0, duplicateFirstName.indexOf(' '));

                                var prevDuplicatePack = '\r\n"' + duplicateFirstName + ' ' + surname + '",';
                                prevDuplicatePack += '"' + phoneNumber + '",';
                                prevDuplicatePack += ('"' + duplicateFirstName + '.' + surname + '@gmail.com"').toLowerCase();

                                currentDuplicateCount++;
                            }

                            csvLine += csvLine.concat('"', firstName, ' ', surname, '",');
                            csvLine += '"' + phoneNumber + '",';
                            csvLine += ('"' + firstName + '.' + surname + '@gmail.com"').toLowerCase();

                            csvData += csvLine;
                        }

                        if (prevDuplicatePack !== null) {
                            csvData += prevDuplicatePack;
                            prevDuplicatePack = null;
                        }

                        dom.log.info('Creating Bulk insert job');

                        var options = {
                            'operation': 'insert',
                            'object': 'Contact',
                            'contentType': 'CSV',
                            'lineEnding': 'CRLF',
                            'data': csvData
                        }
                        sf.bulk.doJob(options, function() {
                            dom.log.success('Bulk job queued. Check for new Contacts');
                        }, function() {
                            dom.log.error('Unknown Bulk error! Please, try again');
                        })
                    } else {
                        dom.log.error('Unhandled network error');
                    }
                });
            } else {
                dom.log.error('Unhandled network error');
            }
        });
    },
    createAccounts: function(count) {
        if (Number.isNaN(parseInt(count))) {
            dom.log.error('Count is not a number');
            return;
        }

        dom.log.info('Getting companies names examples');

        var maxDuplicateCount = Math.round(count * 0.5);
        count -= maxDuplicateCount;
        var currentDuplicateCount = 0;

        net.ajax('https://en.wikipedia.org/wiki/List_of_companies_of_the_United_States', 'GET', {}, {}, function(xhr) {
            if (xhr.status === 200 || xhr.status === 304) {
                var html = document.createElement('html');
                html.innerHTML = xhr.responseText;

                var companies = html.querySelectorAll('div.columns.column-count > ul > li > a');

                var csvData = '"Name","Website","Phone"';

                dom.log.info('Generating Account records');

                var prevDuplicateData = null;

                for (var i = 0; i < count; i++) {

                    var accountName = companies[Math.round(Math.random() * (companies.length - 1))].innerHTML.replace(/&amp;/g, '&');
                    var website = 'http://' + accountName.toLowerCase().replace(/ /g, '').replace(/\./g, '').replace(/\,/g, '').replace(/\'/g, '').replace(/\&amp;/g, '') + '.com';
                    var phoneNumber = '(' + Math.round(Math.random() * 1000) + ') ' + Math.round(Math.random() * 1000) + '-' + Math.round(Math.random() * 1000);

                    var csvLine = '\r\n"' + accountName + '",';
                    csvLine += '"' + website + '",';
                    csvLine += '"' + phoneNumber + '"';
                    
                    csvData += csvLine;

                    if (Math.random() > 0.2 && currentDuplicateCount < maxDuplicateCount) {
                        currentDuplicateCount++;

                        if (prevDuplicateData !== null) {
                            csvData += prevDuplicateData;
                            prevDuplicateData = null;
                        }

                        var duplicateCompanyName = accountName;
                        if (accountName.toLowerCase().indexOf('inc') > -1)
                            duplicateCompanyName = duplicateCompanyName.replace('Inc.', 'Corp');
                        else if (accountName.toLowerCase().indexOf('corp') > -1 || accountName.toLowerCase().indexOf('corporation') > -1)
                            duplicateCompanyName = duplicateCompanyName.replace('Corp', 'Inc.');
                        else if (accountName.toLowerCase().indexOf('ltd') > -1)
                            duplicateCompanyName = duplicateCompanyName.replace('Ltd.', '');
                        else if (accountName.toLowerCase().indexOf('group') > -1)
                            duplicateCompanyName = duplicateCompanyName.replace('Group', '');
                        else if (accountName.toLowerCase().indexOf('international') > -1)
                            duplicateCompanyName = duplicateCompanyName.replace('International', 'Corporation');
                        else duplicateCompanyName = duplicateCompanyName + ' Ltd.';

                        prevDuplicateData = '"' + duplicateCompanyName + '","' + website + '","' + phoneNumber + '"';
                        console.log(csvLine);
                        console.log(prevDuplicateData);
                    }
                }

                if (prevDuplicateData !== null) {
                    csvData += prevDuplicateData;
                    prevDuplicateData = null;
                }

                dom.log.info('Creating Bulk job for insert Accounts');

                var options = {
                    'operation': 'insert',
                    'object': 'Account',
                    'contentType': 'CSV',
                    'lineEnding': 'CRLF',
                    'data': csvData
                };

                 sf.bulk.doJob(options, function() {
                     dom.log.success('Bulk job queued. Check for new Accounts');
                 }, function() {
                     dom.log.error('Unknown Bulk error. Please, try again');
                 });
            } else {
                dom.log.error('Unknown net error');
            }
        });
    },
    createLeads: function(count) {
        if (Number.isNaN(parseInt(count))) {
            dom.log.error('Count is not a number');
            return;
        }

        var maxDuplicateCount = Math.round(count * 0.5);
        count -= maxDuplicateCount;
        var currentDuplicateCount = 0;

        dom.log.info('Getting names examples');

        var namesPage = Math.round(Math.random() * 12) + 1;
        net.ajax('https://www.behindthename.com/names/usage/english/' + namesPage, 'GET', {}, {}, function(xhr) {
            if (xhr.status === 200) {
                var html = document.createElement('html');
                html.innerHTML = xhr.responseText;

                var firstNames = html.querySelectorAll('.browsename');

                dom.log.info('Getting Surnames examples');

                net.ajax('https://www.houseofnames.com/top-surnames.html', 'GET', {}, {}, function(xhr) {
                    if (xhr.status === 200) {
                        var html = document.createElement('html');
                        html.innerHTML = xhr.responseText;

                        var surnames = html.querySelectorAll('#mainNoScrolls div > a > b');

                        dom.log.info('Getting companies names examples');

                        net.ajax('https://en.wikipedia.org/wiki/List_of_companies_of_the_United_States', 'GET', {}, {}, function(xhr) {
                            if (xhr.status === 200 || xhr.status === 304) {
                                var html = document.createElement('html');
                                html.innerHTML = xhr.responseText;
                
                                var companies = html.querySelectorAll('div.columns.column-count > ul > li > a');

                                dom.log.info('Generating Leads records');

                                var csvData = '"FirstName","LastName","Company","Phone","Website","Email"';

                                var prevDuplicateData = null;

                                for (var i = 0; i < count; i++) {

                                    var firstNameIndex = Math.round(Math.random() * (firstNames.length - 1));
                                    var surnameIndex = Math.round(Math.random() * (surnames.length - 1));
                                    var phoneNumber = '(' + Math.round(Math.random() * 1000) + ') ' + Math.round(Math.random() * 1000) + '-' + Math.round(Math.random() * 1000) + '';
                                    var companyName = companies[Math.round(Math.random() * (companies.length - 1))].innerHTML.replace(/&amp;/g, '');
                                    var website = companyName.toLowerCase().replace(/ /g, '').replace(/\./g, '').replace(/\,/g, '').replace(/\'/g, '').replace(/\&amp;/g, '');

                                    var firstName = firstNames[firstNameIndex].querySelector('b > a').innerHTML.toLowerCase();
                                    firstName = firstName[0].toUpperCase() + firstName.substring(1);
                                    if (firstName.indexOf(' ') > -1)
                                        firstName = firstName.substring(0, firstName.indexOf(' '));
                                    var surname = surnames[surnameIndex].innerHTML;
                                    surname = surname.substring(0, surname.indexOf(' '));

                                    var csvLine = '\r\n"' + firstName + '","' + surname + '","' + companyName + '","' + phoneNumber + '","http://' + website + '.com","' + (firstName + '.' + surname + '@' + website + '.com');
                                    csvData += csvLine;

                                    //Create duplicate
                                    if (Math.random() > 0.2 && currentDuplicateCount < maxDuplicateCount) {
                                        currentDuplicateCount++;

                                        if (prevDuplicateData !== null) {
                                            csvData += prevDuplicateData;
                                            prevDuplicateData = null;
                                        }

                                        var duplicateCompanyName = companyName;
                                        if (companyName.toLowerCase().indexOf('inc') > -1)
                                            duplicateCompanyName = duplicateCompanyName.replace('Inc.', 'Corp');
                                        else if (companyName.toLowerCase().indexOf('corp') > -1 || companyName.toLowerCase().indexOf('corporation') > -1)
                                            duplicateCompanyName = duplicateCompanyName.replace('Corp', 'Inc.');
                                        else if (companyName.toLowerCase().indexOf('ltd') > -1)
                                            duplicateCompanyName = duplicateCompanyName.replace('Ltd.', '');
                                        else if (companyName.toLowerCase().indexOf('group') > -1)
                                            duplicateCompanyName = duplicateCompanyName.replace('Group', '');
                                        else if (companyName.toLowerCase().indexOf('international') > -1)
                                            duplicateCompanyName = duplicateCompanyName.replace('International', 'Corporation');
                                        else duplicateCompanyName = duplicateCompanyName + ' Ltd.';

                                        var duplicateEmail = (firstName + '.' + surname + '@' + website + '.com');
                                        if (Math.random() > 0.3) {
                                            duplicateEmail = surname + '@' + website + '.com';
                                        }

                                        var prevDuplicateData = '\r\n"' + firstName + '","' + surname + '","' + duplicateCompanyName + '","' + phoneNumber + '","http://' + website + '.com","' + duplicateEmail + '"';
                                        console.log(csvLine);
                                        console.log(prevDuplicateData);
                                    }
                                }

                                if (prevDuplicateData !== null) {
                                    csvData += prevDuplicateData;
                                    prevDuplicateData = null;
                                }

                                dom.log.info('Creating Bulk job for insert Leads')

                                var options = {
                                    'operation': 'insert',
                                    'object': 'Lead',
                                    'contentType': 'CSV',
                                    'lineEnding': 'CRLF',
                                    'data' : csvData
                                 };

                                sf.bulk.doJob(options, function() {
                                    dom.log.success('Bulk job queued. Check for new Leads');
                                }, function() {
                                    dom.log.error('Unknown Bulk error. Please, try again');
                                });
                            } else {
                                dom.log.error('Unknown net error');
                            }
                        });
                    } else {
                dom.log.error('Unknown net error');
                dom.log.error('Unhandled network error');
                    }
                });
            } else {
                dom.log.error('Unknown net error');
            }
        });
    }
}

window.addEventListener('load', function () {
    dom.log.info('App Initialized');
});

function login() {
    if (document.getElementById('salesforce-username').value === '') {
        dom.log.error('Enter Salesforce username');
        return;
    }

    if (document.getElementById('salesforce-password').value === '') {
        dom.log.error('Enter Salesforce password');
        return;
    }

    dom.log.info('Connecting to Salesforce');
    sf.connection.login(document.getElementById('salesforce-username').value, document.getElementById('salesforce-password').value, document.getElementById('salesforce-token').value, function() {
        dom.log.success('Successfully logged in Salesforce');
    }, function(error) {
        dom.log.error(error);
    });
}

function recursiveDelete(apiName) {
    if (!sf.connection.isLoggedIn) {
        dom.log.error('You must be logged in');
        return;
    }

    sf.utils.recursiveDelete(apiName);
}