package org.metadatacenter.util.test;

import org.junit.jupiter.api.*;
import org.metadatacenter.bridge.CedarDataServices;
import org.metadatacenter.config.CedarConfig;
import org.metadatacenter.config.environment.CedarEnvironmentVariableProvider;
import org.metadatacenter.id.CedarFolderId;
import org.metadatacenter.model.SystemComponent;
import org.metadatacenter.model.folderserver.basic.*;
import org.metadatacenter.rest.context.*;
import org.metadatacenter.server.*;
import org.metadatacenter.server.security.model.auth.*;
import org.metadatacenter.server.security.model.permission.resource.*;
import org.metadatacenter.server.security.model.user.CedarUser;

import java.util.*;
import java.util.stream.*;
import static org.junit.jupiter.api.Assertions.*;

/** Opt-in: -Dtest=PermissionHistoryExperiment -Dcedar.fuzz.runs=30. No HTTP or search-index mocks. */
class PermissionHistoryExperiment {
  static CedarConfig config;
  static CedarUser owner, reader;
  static CedarRequestContext ownerContext, readerContext;
  static CedarFolderId home;
  static final ResourceRole[] ROLES = {null, ResourceRole.VIEWER, ResourceRole.EDITOR, ResourceRole.MANAGER};

  @BeforeAll static void start() throws Exception {
    EmbeddedCedarNeo4j.startAndRedirectEnvironment(Map.of("CEDAR_REDIS_PERSISTENT_PORT", "1"));
    EmbeddedCedarNeo4j.startRedirectAndSeed(SystemComponent.SERVER_RESOURCE);
    config = CedarConfig.getInstance(CedarEnvironmentVariableProvider.getFor(SystemComponent.SERVER_RESOURCE));
    owner = TestAuthUtil.getTestUser1(config); reader = TestAuthUtil.getTestUser2(config);
    ownerContext = CedarRequestContextFactory.fromUser(owner); readerContext = CedarRequestContextFactory.fromUser(reader);
    home = folders().findHomeFolderOf().getResourceId();
  }

  static FolderServiceSession folders() { return CedarDataServices.getInstance().getFolderServiceSession(ownerContext); }
  static ResourcePermissionServiceSession permissions(CedarRequestContext context) {
    return CedarDataServices.getInstance().getResourcePermissionServiceSession(context);
  }

  @TestFactory Stream<DynamicTest> histories() {
    long first = Long.getLong("cedar.fuzz.seed", 820000L);
    return IntStream.range(0, Integer.getInteger("cedar.fuzz.runs", 10)).mapToObj(i ->
        DynamicTest.dynamicTest("permission history " + (first+i), () -> run(first+i)));
  }

  void run(long seed) {
    var random = new Random(seed);
    var trace = new ArrayList<String>();
    var nodes = new ArrayList<FolderServerFolder>();
    int[] parent = {-1, 0, 1, -1, 3, 4}, direct = new int[6], groupGrant = new int[6];
    var groups = CedarDataServices.getInstance().getGroupServiceSession(ownerContext);
    var group = groups.createGroup("history-" + seed, "Isolated generated permission history");
    boolean member = false;
    try {
      for (int i=0; i<6; i++) {
        var folder = new FolderServerFolder(); folder.setName("history-" + seed + "-" + i);
        nodes.add(folders().createFolderAsChildOfId(folder, parent[i]<0 ? home : nodes.get(parent[i]).getResourceId(),
            config.getLinkedDataUtil().buildNewLinkedDataIdObject(CedarFolderId.class)));
        assertNotNull(nodes.get(i));
      }
      for (int step=0; step<Integer.getInteger("cedar.fuzz.steps", 50); step++) {
        int node=random.nextInt(6);
        switch (random.nextInt(4)) {
          case 0, 1 -> {
            direct[node]=random.nextInt(4); groupGrant[node]=random.nextInt(4);
            trace.add("grant " + node + " user=" + direct[node] + " group=" + groupGrant[node]);
            var request = new ResourcePermissionsRequest();
            request.setOwner(new ResourcePermissionUser(owner.getId()));
            if (direct[node]>0) request.getUserPermissions().add(new ResourcePermissionUserPermissionPair(
                new ResourcePermissionUser(reader.getId()), ROLES[direct[node]]));
            if (groupGrant[node]>0) request.getGroupPermissions().add(new ResourcePermissionGroupPermissionPair(
                new ResourcePermissionGroup(group.getId()), ROLES[groupGrant[node]]));
            var result=permissions(ownerContext).updateResourcePermissions(nodes.get(node).getResourceId(), request);
            assertFalse(result.isError(), () -> result.getFirstErrorMessage());
          }
          case 2 -> {
            int destination=random.nextInt(7)-1;
            boolean cycle=false;
            for (int p=destination; p>=0; p=parent[p]) if (p==node) cycle=true;
            trace.add("move " + node + " to " + destination + " cycle=" + cycle);
            assertEquals(!cycle, folders().moveFolder(nodes.get(node).getResourceId(),
                destination<0 ? home : nodes.get(destination).getResourceId()));
            if (!cycle) parent[node]=destination;
          }
          case 3 -> {
            member=!member; trace.add("group member=" + member);
            var request = new CedarGroupUsersRequest();
            request.getUsers().add(new CedarGroupUserRequest(new ResourcePermissionUser(owner.getId()), true, true));
            if (member) request.getUsers().add(new CedarGroupUserRequest(new ResourcePermissionUser(reader.getId()), false, true));
            assertFalse(groups.updateGroupUsers(group.getResourceId(), request).isError());
          }
        }
        for (int i=0; i<6; i++) {
          int userRole=0, groupRole=0;
          for (int p=i; p>=0; p=parent[p]) {
            userRole=Math.max(userRole, direct[p]); groupRole=Math.max(groupRole, groupGrant[p]);
          }
          int effective=Math.max(userRole, member ? groupRole : 0);
          var id=nodes.get(i).getResourceId();
          assertEquals(ROLES[effective], permissions(readerContext).getResourceAuthority(id).highestSatisfiedRole(), "effective node " + i);
          assertFalse(permissions(readerContext).userIsOwnerOfResource(id), "grant must not transfer ownership");
          var materialized=permissions(ownerContext).getResourceMaterializedPermission(id);
          assertEquals(ROLES[effective], materialized.getUserRoles().get(reader.getId()), "effective materialized user node " + i);
          assertEquals(ROLES[groupRole], materialized.getGroupRoles().get(group.getId()), "group projection node " + i);
          assertEquals(ResourceRole.MANAGER, materialized.getUserRoles().get(owner.getId()));
        }
      }
    } catch (Throwable failure) {
      throw new AssertionError("seed=" + seed + "\n" + String.join("\n",trace), failure);
    }
  }
}
