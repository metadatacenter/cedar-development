export const artifactCapabilities = {
  viewer: ['readResource'],
  editor: ['readResource', 'updateResource', 'deleteResource'],
  manager: [
    'readResource', 'updateResource', 'deleteResource', 'manageGrants', 'moveResource', 'manageOpenView',
  ],
  owner: [
    'readResource', 'updateResource', 'deleteResource', 'manageGrants', 'moveResource', 'manageOpenView',
    'transferOwnership',
  ],
};

export const folderCapabilities = {
  viewer: ['readResource', 'listFolderContents'],
  editor: [
    'readResource', 'listFolderContents', 'updateResource', 'createInFolder', 'copyIntoFolder',
    'moveIntoFolder', 'deleteResource',
  ],
  manager: [
    'readResource', 'listFolderContents', 'updateResource', 'createInFolder', 'copyIntoFolder',
    'moveIntoFolder', 'deleteResource', 'manageGrants', 'moveResource', 'manageOpenView',
  ],
  owner: [
    'readResource', 'listFolderContents', 'updateResource', 'createInFolder', 'copyIntoFolder',
    'moveIntoFolder', 'deleteResource', 'manageGrants', 'moveResource', 'manageOpenView',
    'transferOwnership',
  ],
};

export const categoryCapabilities = {
  viewer: ['readCategory'],
  classifier: ['readCategory', 'attachCategory', 'detachCategory'],
  editor: [
    'readCategory', 'attachCategory', 'detachCategory', 'updateCategory', 'createChildCategory',
    'deleteCategory',
  ],
  manager: [
    'readCategory', 'attachCategory', 'detachCategory', 'updateCategory', 'createChildCategory',
    'deleteCategory', 'manageGrants', 'moveCategory',
  ],
  owner: [
    'readCategory', 'attachCategory', 'detachCategory', 'updateCategory', 'createChildCategory',
    'deleteCategory', 'manageGrants', 'moveCategory', 'transferOwnership',
  ],
};

export const fieldActions = {
  viewer: ['copyFromResource'],
  editor: ['copyFromResource'],
  manager: ['copyFromResource', 'enableOpenView'],
  owner: ['copyFromResource', 'enableOpenView'],
};

export const folderActions = {
  viewer: [],
  editor: [],
  manager: ['enableOpenView'],
  owner: ['enableOpenView'],
};

export const permissionActionNames = [
  'copyFromResource', 'enableOpenView', 'disableOpenView',
];

export function filesystemAcl(ownerId, userRoles = [], groupRoles = []) {
  return {
    owner: { '@id': ownerId },
    userPermissions: userRoles.map(({ id, role }) => ({ user: { '@id': id }, role })),
    groupPermissions: groupRoles.map(({ id, role }) => ({ group: { '@id': id }, role })),
  };
}

export function categoryAcl(userRoles = [], groupRoles = []) {
  return {
    userPermissions: userRoles.map(({ id, role }) => ({ user: { '@id': id }, role })),
    groupPermissions: groupRoles.map(({ id, role }) => ({ group: { '@id': id }, role })),
  };
}

export function sameMembers(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && expected.every(value => actual.includes(value));
}

export function samePermissionActions(actual, expected) {
  return Array.isArray(actual)
    && sameMembers(actual.filter(value => permissionActionNames.includes(value)), expected);
}
