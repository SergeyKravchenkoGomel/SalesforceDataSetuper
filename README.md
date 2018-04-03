# SalesforceDataSetuper
Mass delete records (with related records) from Salesforce.
Create fully random records of Accounts, Leads and Contacts with duplicates records
***
### Login

Enter your **Username** and **Password** to relevant inputs.
Enter *Security Token* if required.
***
### Mass record deleting

You have some button presets to delete some frequent SObjects. Press on its after login to delete.
If you need to delete some custom object, open Developer Console in your *browser* and enter code below:
```javascript
sf.utils.recursiveDelete('SObjectApiName')
```
Where ``SObjectApiName`` - Api Name of deleting object in Salesforce

If data isn't deleted - just wait or try again (It must help).
***
### Test Data Factory

You can create some test data to your org. To do this login to Salesforce, after that enter count of creating records and press on relevant button.
Now you can create:
* Contact records (``First Name``, ``Last Name``, ``Email``, ``Phone``)
* Account records (``Name``, ``Website``, ``phone``)
* Lead records (``Company Name``, ``Phone``, ``Website``)

Records are creating with duplicated records in relation ~1:2
