#!/usr/bin/env python3
"""Generate reviewable Apple Shortcuts plists. Credentials are entered after import.
Uses only native actions; signing is separate so sources stay reproducible.
"""
import json
import plistlib
import uuid
from pathlib import Path

OUT = Path(__file__).parent / 'shortcuts'
OUT.mkdir(exist_ok=True)

def token(output):
    return {'Type': 'ActionOutput', 'OutputUUID': output, 'OutputName': 'Output'}

def attachment(output):
    return {'WFSerializationType': 'WFTextTokenAttachment', 'Value': token(output)}

# Explicit UTF-16 offsets are required by Shortcuts' attributed strings.
def rich(parts):
    value = ''; refs = {}
    for part in parts:
        if isinstance(part, dict):
            refs['{%d, 1}' % (len(value.encode('utf-16-le')) // 2)] = part
            value += '\ufffc'
        else:
            value += part
    return {'WFSerializationType': 'WFTextTokenString', 'Value': {'string': value, 'attachmentsByRange': refs}}

def generate(name, kind, place=None):
    actions = []
    def action(identifier, **params):
        uid = str(uuid.uuid5(uuid.NAMESPACE_URL, name + '/' + str(len(actions)))).upper()
        actions.append({'WFWorkflowActionIdentifier': 'is.workflow.actions.' + identifier, 'WFWorkflowActionParameters': {'UUID': uid, **params}})
        return uid
    action('comment', WFCommentActionText='SETUP: edit deviceId in Text, choose the dedicated iCloud Shortcuts/Alexia/events folder in Save File, and replace the HTTPS URL and Bearer token in Get Contents of URL. Save happens before the network attempt. Never share a configured shortcut. A failed HTTP call still leaves the event file queued. Run manually once to grant permissions.')
    date = action('date', WFDateActionMode='Current Date')
    formatted = action('format.date', WFDate=rich([token(date)]), WFDateFormatStyle='ISO 8601', WFISO8601IncludeTime=True)
    stamp = action('format.date', WFDate=rich([token(date)]), WFDateFormatStyle='Custom', WFDateFormat='yyyyMMddHHmmssSSS')
    random1 = action('number.random', WFRandomNumberMinimum=100000000, WFRandomNumberMaximum=999999999)
    random2 = action('number.random', WFRandomNumberMinimum=100000000, WFRandomNumberMaximum=999999999)
    eid = action('gettext', WFTextActionText=rich(['evt-', token(stamp), '-', token(random1), '-', token(random2)]))
    payload = json.dumps({'placeId': place} if place else {}, separators=(',', ':'))
    extra = []
    if kind == 'location.snapshot':
        location = action('getcurrentlocation')
        lat = action('properties.locations', WFInput=attachment(location), WFContentItemPropertyName='Latitude')
        lon = action('properties.locations', WFInput=attachment(location), WFContentItemPropertyName='Longitude')
        # Read as dictionary numbers after JSON conversion; device locale must be verified.
        extra = ['{"latitude":"', token(lat), '","longitude":"', token(lon), '"}']
    body = action('gettext', WFTextActionText=rich(['{"schemaVersion":1,"deviceId":"my-iphone","eventId":"', token(eid), '","type":', json.dumps(kind), ',"occurredAt":"', token(formatted), '","payload":'] + (extra or [payload]) + ['}']))
    named = action('setitemname', WFInput=attachment(body), WFName=rich([token(eid), '.json']))
    action('documentpicker.save', WFInput=attachment(named), WFAskWhereToSave=False, WFSaveFileOverwrite=False, WFFileDestinationPath='Alexia/events/', WFFileStorageService='iCloud Drive')
    action('downloadurl', WFURL=rich(['https://YOUR-MAC.YOUR-TAILNET.ts.net/v1/events']), WFHTTPMethod='POST', ShowHeaders=True, WFHTTPBodyType='File', WFRequestVariable=attachment(named), WFHTTPHeaders={'Value': {'WFDictionaryFieldValueItems': [{'WFItemType':0, 'WFKey':rich(['Authorization']),'WFValue':rich(['Bearer REPLACE-WITH-YOUR-PRIVATE-EVENT-TOKEN'])},{'WFItemType':0,'WFKey':rich(['Content-Type']),'WFValue':rich(['application/json'])}]}, 'WFSerializationType':'WFDictionaryFieldValue'})
    workflow = {'WFWorkflowName':name, 'WFWorkflowClientVersion':'3030.0.4', 'WFWorkflowMinimumClientVersion':900, 'WFWorkflowMinimumClientVersionString':'900', 'WFWorkflowIcon':{'WFWorkflowIconStartColor':4282601983,'WFWorkflowIconGlyphNumber':59511}, 'WFWorkflowActions':actions, 'WFWorkflowTypes':[], 'WFWorkflowInputContentItemClasses':[], 'WFWorkflowHasShortcutInputVariables':False}
    (OUT / (name + '.unsigned.shortcut')).write_bytes(plistlib.dumps(workflow, fmt=plistlib.FMT_BINARY))

for name, kind, place in [('Alexia - Workout ended','workout.ended',None), ('Alexia - Location snapshot','location.snapshot',None)] + [('Alexia - '+label+' '+direction,'place.'+direction,key) for key,label in [('home','Home'),('gym','Gym'),('work','Work')] for direction in ['arrived','left']]:
    generate(name,kind,place)
print('Generated eight templates. Sign with shortcuts sign before importing on iOS.')
