import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalFlow } from '@server/entities/ApprovalFlow';
import { ApprovalFlowStep } from '@server/entities/ApprovalFlowStep';
import { ApprovalFlowVersion } from '@server/entities/ApprovalFlowVersion';
import { ApprovalInstance } from '@server/entities/ApprovalInstance';
import { ApprovalTask } from '@server/entities/ApprovalTask';
import { Project } from '@server/entities/Project';
import { User } from '@server/entities/User';
import { ApprovalInstanceService } from '@server/services/approvalInstanceService';
import { getTestDataSource, setupTestDb, teardownTestDb } from '../helpers/database';

describe('ApprovalInstanceService 集成', () => {
  beforeEach(async () => {
    const dataSource = await setupTestDb();
    const userRepo = dataSource.getRepository(User);
    const [applicant, approverA, approverB] = await userRepo.save([
      { id: 1, username: 'applicant', password: 'hash', realName: '申请人' },
      { id: 2, username: 'approver-a', password: 'hash', realName: '审批人甲' },
      { id: 3, username: 'approver-b', password: 'hash', realName: '审批人乙' },
    ]);
    await dataSource.getRepository(Project).save({
      id: 1,
      name: '会签项目',
      code: 'COUNTERSIGN',
      status: 'active',
      managers: [approverA, approverB],
    });
    const flow = await dataSource.getRepository(ApprovalFlow).save({
      name: '加班会签',
      type: 'overtime',
      isDefault: true,
      enabled: true,
    });
    await dataSource.getRepository(ApprovalFlowStep).save({
      flowId: flow.id,
      stepOrder: 1,
      stepType: 'project_manager',
      label: '项目管理员会签',
      parentLevel: 1,
      customApproverId: null,
      requireAllApprovers: true,
    });
    await dataSource.getRepository(ApprovalFlowVersion).save({
      flowId: flow.id,
      flowName: flow.name,
      type: 'overtime',
      version: 1,
      description: null,
      isDefault: true,
      enabled: true,
      steps: [{
        stepOrder: 1,
        stepType: 'project_manager',
        label: '项目管理员会签',
        parentLevel: 1,
        customApproverId: null,
        requireAllApprovers: true,
      }],
    });
    expect(applicant.id).toBe(1);
  });

  afterEach(teardownTestDb);

  it('会签在最后一名审批人通过后推进到完成', async () => {
    const dataSource = getTestDataSource();
    const started = await dataSource.transaction((manager) => new ApprovalInstanceService(manager).start({
      targetType: 'overtime',
      targetId: 50,
      applicantId: 1,
      projectId: 1,
    }));
    expect(started.status).toBe('submitted');
    expect(started.firstApproverIds.sort()).toEqual([2, 3]);

    const first = await dataSource.transaction((manager) => new ApprovalInstanceService(manager).act({
      targetType: 'overtime',
      targetId: 50,
      approverId: 2,
      approverName: '审批人甲',
      action: 'approve',
    }));
    expect(first.status).toBe('submitted');

    const second = await dataSource.transaction((manager) => new ApprovalInstanceService(manager).act({
      targetType: 'overtime',
      targetId: 50,
      approverId: 3,
      approverName: '审批人乙',
      action: 'approve',
    }));
    expect(second.status).toBe('approved');

    const instance = await dataSource.getRepository(ApprovalInstance).findOneByOrFail({ id: started.instance.id });
    const tasks = await dataSource.getRepository(ApprovalTask).findBy({ instanceId: instance.id });
    expect(instance.status).toBe('approved');
    expect(tasks.map((task) => task.status).sort()).toEqual(['approved', 'approved']);
  });
});
