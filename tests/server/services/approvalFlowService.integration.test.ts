import bcrypt from 'bcryptjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalFlow } from '@server/entities/ApprovalFlow';
import { ApprovalFlowVersion } from '@server/entities/ApprovalFlowVersion';
import { ApprovalInstance } from '@server/entities/ApprovalInstance';
import { Department } from '@server/entities/Department';
import { Group } from '@server/entities/Group';
import { User } from '@server/entities/User';
import { ApprovalFlowEngine } from '@server/services/approvalFlowService';
import { ApprovalInstanceService } from '@server/services/approvalInstanceService';
import { getTestDataSource, setupTestDb, teardownTestDb } from '../helpers/database';

describe('审批流程配置集成', () => {
  beforeEach(setupTestDb);
  afterEach(teardownTestDb);

  async function createUser(username: string, status = 1) {
    return getTestDataSource().getRepository(User).save({
      username,
      password: await bcrypt.hash('password-123', 4),
      realName: username,
      status,
      roles: [],
    });
  }

  it('默认流程必须启用、自定义审批人必须存在且处于启用状态', async () => {
    const engine = new ApprovalFlowEngine(getTestDataSource().manager);
    const disabled = await createUser('disabled-approver', 0);

    await expect(engine.createFlow({
      name: '停用默认流程',
      type: 'timesheet',
      isDefault: true,
      enabled: false,
      steps: [{ stepType: 'group_leader', label: '组长审批' }],
    })).rejects.toThrow('默认审批流程必须启用');

    await expect(engine.createFlow({
      name: '错误审批人',
      type: 'timesheet',
      steps: [{ stepType: 'custom', label: '指定人员', customApproverId: 999 }],
    })).rejects.toThrow('自定义审批人不存在');

    await expect(engine.createFlow({
      name: '停用审批人',
      type: 'timesheet',
      steps: [{ stepType: 'custom', label: '指定人员', customApproverId: disabled.id }],
    })).rejects.toThrow('自定义审批人已被禁用');
  });

  it('拒绝无效步骤，并禁止无项目上下文的业务使用项目审批人', async () => {
    const engine = new ApprovalFlowEngine(getTestDataSource().manager);

    await expect(engine.createFlow({
      name: '错误步骤类型',
      type: 'timesheet',
      steps: [{ stepType: 'unknown', label: '未知审批' }],
    })).rejects.toThrow('第1个审批步骤类型无效');

    await expect(engine.createFlow({
      name: '错误上级层级',
      type: 'timesheet',
      steps: [{ stepType: 'parent_leader', label: '上级审批', parentLevel: 6 }],
    })).rejects.toThrow('上级层级必须为1至5');

    for (const type of ['weekly_report', 'permission_request']) {
      await expect(engine.createFlow({
        name: `${type}项目审批`,
        type,
        steps: [{ stepType: 'project_manager', label: '项目管理员审批' }],
      })).rejects.toThrow('不支持模块SE或项目管理员步骤');
    }

    await expect(engine.createFlow({
      name: '工时项目审批',
      type: 'timesheet',
      steps: [{ stepType: 'project_manager', label: '项目管理员审批' }],
    })).resolves.toMatchObject({ type: 'timesheet' });
  });

  it('切换默认流程后每种类型仍只有一个默认项', async () => {
    const dataSource = getTestDataSource();
    const approver = await createUser('approver');
    const engine = new ApprovalFlowEngine(dataSource.manager);
    const first = await engine.createFlow({
      name: '流程一',
      type: 'timesheet',
      isDefault: true,
      steps: [{ stepType: 'custom', label: '审批', customApproverId: approver.id }],
    });
    const second = await engine.createFlow({
      name: '流程二',
      type: 'timesheet',
      isDefault: false,
      steps: [{ stepType: 'custom', label: '审批', customApproverId: approver.id }],
    });
    expect([first?.id, second?.id]).toEqual([1, 2]);
    expect(await dataSource.getRepository(ApprovalFlow).count()).toBe(2);

    await engine.updateFlow(second!.id, { isDefault: true });
    const flows = await dataSource.getRepository(ApprovalFlow).find();
    expect(flows.map(flow => ({ name: flow.name, type: flow.type, isDefault: flow.isDefault }))).toEqual([
      { name: '流程一', type: 'timesheet', isDefault: false },
      { name: '流程二', type: 'timesheet', isDefault: true },
    ]);
  });

  it('默认流程不能被停用、取消默认或删除，适用类型创建后不可改变', async () => {
    const approver = await createUser('approver');
    const engine = new ApprovalFlowEngine(getTestDataSource().manager);
    const flow = await engine.createFlow({
      name: '默认流程',
      type: 'overtime',
      isDefault: true,
      steps: [{ stepType: 'custom', label: '审批', customApproverId: approver.id }],
    });

    await expect(engine.updateFlow(flow!.id, { enabled: false })).rejects.toThrow('默认审批流程必须启用');
    await expect(engine.updateFlow(flow!.id, { isDefault: false })).rejects.toThrow('请先将同类型的其他流程设为默认流程');
    await expect(engine.updateFlow(flow!.id, { type: 'timesheet' })).rejects.toThrow('适用类型创建后不可修改');
    await expect(engine.deleteFlow(flow!.id)).rejects.toThrow('默认审批流程不能删除');
  });

  it('修改步骤会生成新版本，并完整保留旧版本及会签设置', async () => {
    const dataSource = getTestDataSource();
    const approver = await createUser('approver');
    const engine = new ApprovalFlowEngine(dataSource.manager);
    const flow = await engine.createFlow({
      name: '版本流程',
      type: 'weekly_report',
      steps: [{ stepType: 'custom', label: '初审', customApproverId: approver.id }],
    });

    await engine.updateFlow(flow!.id, {
      steps: [{
        stepType: 'custom',
        label: '会签复审',
        customApproverId: approver.id,
        requireAllApprovers: true,
      }],
    });

    const versions = await dataSource.getRepository(ApprovalFlowVersion).find({
      where: { flowId: flow!.id },
      order: { version: 'ASC' },
    });
    expect(versions).toHaveLength(2);
    expect(versions[0].steps[0]).toMatchObject({ label: '初审', requireAllApprovers: false });
    expect(versions[1].steps[0]).toMatchObject({ label: '会签复审', requireAllApprovers: true });
  });

  it('已产生审批历史的非默认流程不可硬删除', async () => {
    const dataSource = getTestDataSource();
    const approver = await createUser('approver');
    const applicant = await createUser('applicant');
    const engine = new ApprovalFlowEngine(dataSource.manager);
    const flow = await engine.createFlow({
      name: '历史流程',
      type: 'permission_request',
      steps: [{ stepType: 'custom', label: '审批', customApproverId: approver.id }],
    });
    await dataSource.getRepository(ApprovalInstance).save({
      targetType: 'permission_request',
      targetId: 1,
      applicantId: applicant.id,
      status: 'approved',
      currentStepOrder: null,
      totalSteps: 1,
      flowId: flow!.id,
      flowVersionId: null,
      flowName: flow!.name,
      flowVersionNumber: 1,
      stepsSnapshot: [],
      submittedAt: new Date(),
      finishedAt: new Date(),
    });

    await expect(engine.deleteFlow(flow!.id)).rejects.toThrow('已有历史审批记录');
  });

  it('缺少默认流程或无法解析审批人时拒绝提交，绝不自动通过', async () => {
    const dataSource = getTestDataSource();
    const applicant = await createUser('applicant');
    const instanceService = new ApprovalInstanceService(dataSource.manager);

    await expect(instanceService.start({
      targetType: 'timesheet',
      targetId: 1,
      applicantId: applicant.id,
    })).rejects.toThrow('未配置可用的默认审批流程');

    const department = await dataSource.getRepository(Department).save({ name: '无负责人部门' });
    const group = await dataSource.getRepository(Group).save({
      name: '无负责人组',
      departmentId: department.id,
      parentId: null,
      level: 0,
      path: '1',
    });
    applicant.department = department;
    applicant.group = group;
    await dataSource.getRepository(User).save(applicant);
    await new ApprovalFlowEngine(dataSource.manager).createFlow({
      name: '无审批人流程',
      type: 'timesheet',
      isDefault: true,
      steps: [{ stepType: 'group_leader', label: '组长审批' }],
    });

    await expect(instanceService.start({
      targetType: 'timesheet',
      targetId: 2,
      applicantId: applicant.id,
    })).rejects.toThrow('未找到有效审批人');
    expect(await dataSource.getRepository(ApprovalInstance).count()).toBe(0);
  });
});
