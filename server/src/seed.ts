import 'reflect-metadata';
import bcrypt from 'bcryptjs';
import { AppDataSource } from './config/database';
import { User } from './entities/User';
import { Department } from './entities/Department';
import { Group } from './entities/Group';
import { Role } from './entities/Role';
import { Permission } from './entities/Permission';
import { Project } from './entities/Project';
import { ProjectSE } from './entities/ProjectSE';
import { ApprovalFlow } from './entities/ApprovalFlow';
import { ApprovalFlowStep } from './entities/ApprovalFlowStep';
import { ApprovalFlowVersion } from './entities/ApprovalFlowVersion';
import { permissionDefinitions } from './config/permissionDefinitions';

async function seed() {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PROD_SEED !== 'true') {
    throw new Error('生产环境禁止运行种子数据。如确需执行，请显式设置 ALLOW_PROD_SEED=true');
  }

  await AppDataSource.initialize();
  console.log('🌱 开始初始化种子数据...');

  // 1. 创建权限
  const permRepo = AppDataSource.getRepository(Permission);
  const allPerms: Permission[] = [];
  for (const def of permissionDefinitions) {
    let perm = await permRepo.findOne({ where: { code: def.code } });
    if (!perm) {
      perm = permRepo.create(def);
    } else {
      perm.name = def.name;
      perm.module = def.module;
      perm.action = def.action;
      perm.grantable = !!def.grantable;
      perm.scopeTypes = def.scopeTypes ?? null;
    }
    perm = await permRepo.save(perm);
    allPerms.push(perm);
  }
  console.log(`✅ 权限初始化完成 (${allPerms.length} 条)`);

  // 2. 创建角色
  const roleRepo = AppDataSource.getRepository(Role);
  const roleData = [
    { name: 'admin', label: '管理员', description: '系统管理员，拥有所有权限' },
    { name: 'manager', label: '部门经理', description: '部门经理，可审批部门内工时/加班/周报' },
    { name: 'group_leader', label: '组长', description: '组长，可审批组内工时/加班/周报' },
    { name: 'employee', label: '普通员工', description: '普通员工，可填报工时/加班/周报' },
  ];

  const allRoles: Role[] = [];
  for (const rd of roleData) {
    let role = await roleRepo.findOne({ where: { name: rd.name } });
    if (!role) {
      role = roleRepo.create(rd);
      await roleRepo.save(role);
    }
    const employeePermissions = [
      'timesheet:access', 'timesheet:create', 'timesheet:update:self', 'timesheet:delete:self', 'timesheet:submit:self', 'timesheet:withdraw:self', 'timesheet:view:self',
      'overtime:access', 'overtime:create', 'overtime:update:self', 'overtime:delete:self', 'overtime:submit:self', 'overtime:withdraw:self', 'overtime:view:self',
      'weekly_report:access', 'weekly_report:create', 'weekly_report:update:self', 'weekly_report:submit:self', 'weekly_report:view:self',
      'approval:access', 'approval:view:todo', 'approval:view:done', 'approval:view:cc', 'approval:approve:assigned', 'approval:withdraw:self',
      'report:access', 'report:view:self',
      'project:access', 'project:view:self',
      'permission_request:access', 'permission_request:create', 'permission_request:view:self',
    ];
    const leaderPermissions = [
      ...employeePermissions,
      'timesheet:view:group', 'overtime:view:group', 'weekly_report:view:group',
      'timesheet:approve:assigned', 'overtime:approve:assigned', 'weekly_report:approve:assigned',
      'report:view:group', 'report:view:project', 'report:view:overtime',
      'project:view:managed', 'project:update', 'project:assign_se',
      'permission_request:approve:assigned',
    ];
    const managerPermissions = [
      ...employeePermissions,
      'timesheet:view:department', 'overtime:view:department', 'weekly_report:view:department',
      'timesheet:approve:assigned', 'overtime:approve:assigned', 'weekly_report:approve:assigned',
      'report:view:department', 'report:view:project', 'report:view:overtime', 'report:export',
      'project:view:managed', 'project:update', 'project:assign_se',
      'permission_request:approve:assigned',
    ];
    if (rd.name === 'admin') {
      role.permissions = allPerms;
    } else if (rd.name === 'manager') {
      role.permissions = allPerms.filter(p => managerPermissions.includes(p.code));
    } else if (rd.name === 'group_leader') {
      role.permissions = allPerms.filter(p => leaderPermissions.includes(p.code));
    } else {
      role.permissions = allPerms.filter(p => employeePermissions.includes(p.code));
    }
    await roleRepo.save(role);
    allRoles.push(role);
  }
  console.log('✅ 角色初始化完成');

  const adminRole = allRoles.find(r => r.name === 'admin')!;
  const managerRole = allRoles.find(r => r.name === 'manager')!;
  const leaderRole = allRoles.find(r => r.name === 'group_leader')!;
  const employeeRole = allRoles.find(r => r.name === 'employee')!;

  // 3. 创建部门（含负责人）
  const deptRepo = AppDataSource.getRepository(Department);
  let techDept = await deptRepo.findOne({ where: { name: '技术研发部' } });
  if (!techDept) {
    techDept = deptRepo.create({ name: '技术研发部', description: '负责产品研发' });
    await deptRepo.save(techDept);
  }
  let productDept = await deptRepo.findOne({ where: { name: '产品设计部' } });
  if (!productDept) {
    productDept = deptRepo.create({ name: '产品设计部', description: '负责产品设计和用户体验' });
    await deptRepo.save(productDept);
  }
  console.log('✅ 部门初始化完成');

  // 4. 创建多层级分组
  const groupRepo = AppDataSource.getRepository(Group);
  const getOrCreateGroup = async (name: string, dept: Department, parent: Group | null, leader?: User) => {
    let group = await groupRepo.findOne({ where: { name } });
    if (!group) {
      const level = parent ? (parent.level || 0) + 1 : 0;
      const path = parent ? (parent.path ? `${parent.path}/${parent.id}` : `${parent.id}`) : '';
      group = groupRepo.create({
        name, department: dept, departmentId: dept.id,
        parent: parent || undefined, parentId: parent?.id || null,
        level, path,
        leader: leader || undefined, leaderId: leader?.id || null,
      });
      await groupRepo.save(group);
      // 更新 path
      if (!group.path) {
        group.path = `${group.id}`;
      }
      await groupRepo.save(group);
    }
    return group;
  };

  // 先创建用户（因为分组需要 leader）
  const userRepo = AppDataSource.getRepository(User);
  const hash = (pw: string) => bcrypt.hash(pw, 10);

  // 先创建必要的用户（不设分组，后面再更新）
  let adminUser = await userRepo.findOne({ where: { username: 'admin' } });
  if (!adminUser) {
    adminUser = userRepo.create({
      username: 'admin', password: await hash('123456'), realName: '系统管理员',
      department: techDept, roles: [adminRole],
    });
    await userRepo.save(adminUser);
  }

  let managerUser = await userRepo.findOne({ where: { username: 'manager1' } });
  if (!managerUser) {
    managerUser = userRepo.create({
      username: 'manager1', password: await hash('123456'), realName: '张经理',
      department: techDept, roles: [managerRole],
    });
    await userRepo.save(managerUser);
  }

  // 设置部门负责人
  techDept.leader = managerUser;
  techDept.leaderId = managerUser.id;
  await deptRepo.save(techDept);

  let leader1 = await userRepo.findOne({ where: { username: 'leader1' } });
  if (!leader1) {
    leader1 = userRepo.create({
      username: 'leader1', password: await hash('123456'), realName: '李组长',
      department: techDept, roles: [leaderRole],
    });
    await userRepo.save(leader1);
  }

  let leader2 = await userRepo.findOne({ where: { username: 'leader2' } });
  if (!leader2) {
    leader2 = userRepo.create({
      username: 'leader2', password: await hash('123456'), realName: '王组长',
      department: techDept, roles: [leaderRole],
    });
    await userRepo.save(leader2);
  }

  let subLeader1 = await userRepo.findOne({ where: { username: 'subleader1' } });
  if (!subLeader1) {
    subLeader1 = userRepo.create({
      username: 'subleader1', password: await hash('123456'), realName: '陈副组长',
      department: techDept, roles: [leaderRole],
    });
    await userRepo.save(subLeader1);
  }

  // 创建多层级分组
  const frontendGroup = await getOrCreateGroup('前端组', techDept, null, leader1);
  const backendGroup = await getOrCreateGroup('后端组', techDept, null, leader2);
  // 二级组
  const feReactGroup = await getOrCreateGroup('React小组', techDept, frontendGroup, subLeader1);
  const feVueGroup = await getOrCreateGroup('Vue小组', techDept, frontendGroup);
  const beJavaGroup = await getOrCreateGroup('Java小组', techDept, backendGroup);
  const beGoGroup = await getOrCreateGroup('Go小组', techDept, backendGroup);

  console.log('✅ 多层级分组初始化完成');

  // 更新用户的分组
  let emp1 = await userRepo.findOne({ where: { username: 'employee1' } });
  if (!emp1) {
    emp1 = userRepo.create({
      username: 'employee1', password: await hash('123456'), realName: '王员工',
      department: techDept, group: feReactGroup, roles: [employeeRole],
    });
    await userRepo.save(emp1);
  } else {
    emp1.group = feReactGroup;
    await userRepo.save(emp1);
  }

  let emp2 = await userRepo.findOne({ where: { username: 'employee2' } });
  if (!emp2) {
    emp2 = userRepo.create({
      username: 'employee2', password: await hash('123456'), realName: '赵员工',
      department: techDept, group: beJavaGroup, roles: [employeeRole],
    });
    await userRepo.save(emp2);
  } else {
    emp2.group = beJavaGroup;
    await userRepo.save(emp2);
  }

  // 更新 leader 的分组
  leader1!.group = frontendGroup;
  await userRepo.save(leader1!);
  leader2!.group = backendGroup;
  await userRepo.save(leader2!);
  subLeader1!.group = feReactGroup;
  await userRepo.save(subLeader1!);

  console.log('✅ 用户初始化完成');

  // 5. 创建项目（含管理员）
  const projectRepo = AppDataSource.getRepository(Project);
  let project1 = await projectRepo.findOne({ where: { code: 'WTM-001' } });
  if (!project1) {
    project1 = projectRepo.create({
      name: '工时管理系统', code: 'WTM-001', description: '企业工时管理系统开发项目',
      managers: [managerUser, adminUser],
    });
    await projectRepo.save(project1);
  } else {
    // 更新已有项目的管理员
    project1.managers = [managerUser, adminUser];
    await projectRepo.save(project1);
  }

  let project2 = await projectRepo.findOne({ where: { code: 'EC-001' } });
  if (!project2) {
    project2 = projectRepo.create({
      name: '电商平台', code: 'EC-001', description: '公司电商平台项目',
      managers: [managerUser],
    });
    await projectRepo.save(project2);
  }

  let project3 = await projectRepo.findOne({ where: { code: 'OA-001' } });
  if (!project3) {
    project3 = projectRepo.create({
      name: '内部OA系统', code: 'OA-001', description: '内部办公自动化系统',
      managers: [leader1!],
    });
    await projectRepo.save(project3);
  }

  // 创建项目SE
  const seRepo = AppDataSource.getRepository(ProjectSE);
  let se1 = await seRepo.findOne({ where: { projectId: project1.id, groupId: frontendGroup.id } });
  if (!se1) {
    se1 = seRepo.create({
      project: project1, projectId: project1.id,
      user: leader1!, userId: leader1!.id,
      group: frontendGroup, groupId: frontendGroup.id,
      userName: leader1!.realName, groupName: frontendGroup.name,
    });
    await seRepo.save(se1);
  }

  let se2 = await seRepo.findOne({ where: { projectId: project1.id, groupId: backendGroup.id } });
  if (!se2) {
    se2 = seRepo.create({
      project: project1, projectId: project1.id,
      user: leader2!, userId: leader2!.id,
      group: backendGroup, groupId: backendGroup.id,
      userName: leader2!.realName, groupName: backendGroup.name,
    });
    await seRepo.save(se2);
  }

  console.log('✅ 项目和SE初始化完成');

  // 6. 创建默认审批流程
  const flowRepo = AppDataSource.getRepository(ApprovalFlow);
  const stepRepo = AppDataSource.getRepository(ApprovalFlowStep);
  const flowVersionRepo = AppDataSource.getRepository(ApprovalFlowVersion);

  const createDefaultFlow = async (type: 'timesheet' | 'overtime' | 'weekly_report' | 'permission_request', name: string, steps: { stepType: any; label: string; parentLevel?: number; customApproverId?: number | null }[]) => {
    // 清除同类型旧的默认
    await flowRepo.update({ type, isDefault: true }, { isDefault: false });

    let flow = await flowRepo.findOne({ where: { name } });
    if (!flow) {
      flow = flowRepo.create({ name, type, isDefault: true, enabled: true });
      await flowRepo.save(flow);
    } else {
      flow.isDefault = true;
      flow.enabled = true;
      await flowRepo.save(flow);
    }

    // 清除旧步骤
    await stepRepo.delete({ flowId: flow.id });

    for (let i = 0; i < steps.length; i++) {
      await stepRepo.save(stepRepo.create({
        flowId: flow.id,
        stepOrder: i + 1,
        stepType: steps[i].stepType,
        label: steps[i].label,
        parentLevel: steps[i].parentLevel || 1,
        customApproverId: steps[i].customApproverId ?? null,
      }));
    }

    const lastVersion = await flowVersionRepo.findOne({
      where: { flowId: flow.id },
      order: { version: 'DESC' },
    });
    await flowVersionRepo.save(flowVersionRepo.create({
      flowId: flow.id,
      flowName: flow.name,
      type: flow.type,
      version: (lastVersion?.version || 0) + 1,
      description: flow.description ?? null,
      isDefault: flow.isDefault,
      enabled: flow.enabled,
      steps: steps.map((step, index) => ({
        stepOrder: index + 1,
        stepType: step.stepType,
        label: step.label,
        parentLevel: step.parentLevel || 1,
        customApproverId: step.customApproverId ?? null,
      })),
    }));

    return flow;
  };

  // 工时审批流程：直属负责人 → 模块SE → 项目管理员
  await createDefaultFlow('timesheet', '工时审批流程（默认）', [
    { stepType: 'group_leader', label: '直属负责人审批' },
    { stepType: 'module_se', label: '模块SE审批' },
    { stepType: 'project_manager', label: '项目管理员审批' },
  ]);

  // 加班审批流程：直属负责人 → 部门负责人
  await createDefaultFlow('overtime', '加班审批流程（默认）', [
    { stepType: 'group_leader', label: '直属负责人审批' },
    { stepType: 'dept_leader', label: '部门负责人审批' },
  ]);

  // 周报审批流程：直属负责人
  await createDefaultFlow('weekly_report', '周报审批流程（默认）', [
    { stepType: 'group_leader', label: '直属负责人审批' },
  ]);

  await createDefaultFlow('permission_request', '权限申请审批流程（默认）', [
    { stepType: 'group_leader', label: '直属负责人审批' },
    { stepType: 'custom', label: '系统管理员审批', customApproverId: adminUser.id },
  ]);

  console.log('✅ 审批流程初始化完成');

  console.log('\n🎉 种子数据初始化完成！');
  console.log('📝 默认账号：');
  console.log('   管理员:  admin / 123456');
  console.log('   经理:    manager1 / 123456 (技术研发部负责人)');
  console.log('   组长:    leader1 / 123456 (前端组组长)');
  console.log('   组长:    leader2 / 123456 (后端组组长)');
  console.log('   副组长:  subleader1 / 123456 (React小组)');
  console.log('   员工:    employee1 / 123456 (React小组)');
  console.log('   员工:    employee2 / 123456 (Java小组)');
  console.log('\n📋 组织架构：');
  console.log('   技术研发部 (负责人: 张经理)');
  console.log('   ├── 前端组 (组长: 李组长)');
  console.log('   │   ├── React小组 (组长: 陈副组长)');
  console.log('   │   └── Vue小组');
  console.log('   └── 后端组 (组长: 王组长)');
  console.log('       ├── Java小组');
  console.log('       └── Go小组');
  console.log('\n📋 默认审批流程：');
  console.log('   工时：组长 → 模块SE → 项目管理员');
  console.log('   加班：组长 → 部门主管');
  console.log('   周报：组长');

  await AppDataSource.destroy();
}

seed().catch(console.error);
